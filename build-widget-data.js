/**
 * WP&R Adoptable Pets — Data Builder v2
 *
 * Key fixes over v1:
 *   - waitForSelector instead of arbitrary timeouts for React SPAs
 *   - Diagnostic HTML dumps on failure (saved to docs/ for debugging)
 *   - User-agent spoofing to avoid bot blocks
 *   - Multiple fallback selector strategies
 *   - Fixed Petfinder org URL format
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const OUTPUT_FILE = path.join(__dirname, 'pet-data.json');
const DIAG_DIR = path.join(__dirname, 'docs');
if (!fs.existsSync(DIAG_DIR)) fs.mkdirSync(DIAG_DIR, { recursive: true });

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function saveDiag(name, html) {
  const file = path.join(DIAG_DIR, `diag-${name}.html`);
  fs.writeFileSync(file, html.substring(0, 80000));
  console.log(`    [diag] Saved: docs/diag-${name}.html`);
}

async function newPage(browser, blockMedia = true) {
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1280, height: 900 });
  if (blockMedia) {
    await page.setRequestInterception(true);
    page.on('request', req => {
      const t = req.resourceType();
      if (['image', 'font', 'stylesheet', 'media'].includes(t)) req.abort();
      else req.continue();
    });
  }
  return page;
}

// ═══ ADOPTAPET (Marathon + Adams) ═══
async function scrapeAdoptapet(browser, shelterId, shelterKey) {
  const baseUrl = `https://www.adoptapet.com/shelter/${shelterId}/available-pets`;
  console.log(`\n[${shelterKey}] Adoptapet: ${baseUrl}`);

  let allPets = [];
  let pageNum = 1;

  while (pageNum <= 10) {
    const url = pageNum === 1 ? baseUrl : `${baseUrl}?page=${pageNum}`;
    console.log(`  Page ${pageNum}: ${url}`);
    const page = await newPage(browser);

    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });

      // Wait for React to render pet cards
      try {
        await page.waitForSelector('a[href*="/pet/"] img', { timeout: 15000 });
        console.log('    OK: pet cards rendered');
      } catch {
        console.log('    WARN: no cards after 15s, trying extra wait...');
        await new Promise(r => setTimeout(r, 5000));
      }

      const result = await page.evaluate(() => {
        const pets = [];
        const seen = new Set();
        const skip = ['Learn More', 'Color', 'Size', 'Details', 'Story', 'N/A', 'new badge', 'Favorite', 'Good with'];

        document.querySelectorAll('a[href*="/pet/"]').forEach(card => {
          const href = card.href;
          if (!href || seen.has(href) || href.includes('blog') || href.includes('advice')) return;
          seen.add(href);

          const img = card.querySelector('img');
          const src = img?.src || '';
          const lines = card.textContent.trim().split('\n').map(s => s.trim()).filter(s =>
            s && s.length < 80 && !skip.some(w => s.includes(w)) && !s.startsWith('(')
          );
          if (lines.length === 0) return;

          let photo = null;
          if (src.includes('adoptapet.com') && !src.includes('NoPetPhoto') && !src.includes('badge')) {
            const m = src.match(/f_auto,q_auto\/(\d+)/);
            photo = m ? `https://media.adoptapet.com/image/upload/c_auto,g_auto,w_400,ar_4:3,dpr_2/f_auto,q_auto/${m[1]}` : src;
          }

          if (lines[0] && lines[0].length < 50) {
            pets.push({ name: lines[0], breed: lines[1] || '', genderAge: lines[2] || '', photo, url: href });
          }
        });

        const cm = document.body.innerText.match(/\d+\s*-\s*\d+\s+of\s+(\d+)/);
        return { pets, totalPets: cm ? parseInt(cm[1]) : 0 };
      });

      allPets.push(...result.pets);
      console.log(`    Found ${result.pets.length} (total ${allPets.length}${result.totalPets ? '/' + result.totalPets : ''})`);
      await page.close();

      if (result.pets.length === 0) break;
      if (result.totalPets > 0 && allPets.length >= result.totalPets) break;
      pageNum++;

    } catch (err) {
      console.error(`    ERR page ${pageNum}: ${err.message}`);
      try { saveDiag(`${shelterKey}-p${pageNum}`, await page.content()); } catch {}
      await page.close();
      break;
    }
  }

  // Deduplicate
  const u = new Map();
  allPets.forEach(p => { if (!u.has(p.url)) u.set(p.url, p); });
  allPets = Array.from(u.values());
  console.log(`  [${shelterKey}] TOTAL: ${allPets.length}`);

  return allPets.map(p => {
    const parts = (p.genderAge || '').split(',').map(s => s.trim());
    const gender = parts.find(s => /male|female/i.test(s)) || '';
    const age = parts.find(s => /yr|mo|wk/i.test(s)) || parts[1] || '';
    const isCat = /shorthair|longhair|siamese|tabby|calico|persian|bengal|ragdoll/i.test(p.breed || '') || /-cat$/.test(p.url || '');
    return { name: p.name, species: isCat ? 'Cat' : 'Dog', breed: p.breed || 'Unknown', age: age || 'Unknown', gender: gender || 'Unknown', bio: '', photo: p.photo, url: p.url };
  });
}

// ═══ PETFINDER (Clark County) ═══
async function scrapePetfinder(browser, orgId, shelterKey) {
  const url = `https://www.petfinder.com/search/pets-for-adoption/?shelter_id=${orgId}&distance=Anywhere`;
  console.log(`\n[${shelterKey}] Petfinder: ${url}`);
  const page = await newPage(browser, false);

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    try { await page.waitForSelector('[data-test="Pet_Card"], a[href*="/details/"]', { timeout: 15000 }); console.log('    OK: cards found'); }
    catch { console.log('    WARN: no cards, extra wait...'); await new Promise(r => setTimeout(r, 8000)); }

    const pets = await page.evaluate(() => {
      const results = [];
      const seen = new Set();

      // Find all detail links
      document.querySelectorAll('a[href*="/details/"]').forEach(link => {
        const href = link.href;
        if (seen.has(href)) return;
        seen.add(href);

        // Walk up to find card container
        const card = link.closest('[data-test="Pet_Card"]') || link.closest('article') || link.parentElement?.parentElement;
        const img = (card || link).querySelector('img');
        const alt = img?.alt || '';
        const nameEl = (card || link).querySelector('h2, h3, [class*="name"], [class*="Name"]');
        const name = nameEl?.textContent?.trim() || alt.split(',')[0] || '';

        if (name && name.length < 60) {
          results.push({ name, altText: alt, photo: img?.src || '', url: href });
        }
      });
      return results;
    });

    console.log(`  Found ${pets.length}`);
    if (pets.length === 0) saveDiag(`${shelterKey}-pf`, await page.content());
    await page.close();

    return pets.map(p => {
      const parts = (p.altText || '').split(',').map(s => s.trim());
      const desc = parts[2] || '';
      const ageM = desc.match(/(Baby|Puppy|Kitten|Young|Adult|Senior)/i);
      const genM = desc.match(/(Male|Female)/i);
      const breed = desc.replace(/(Baby|Puppy|Kitten|Young|Adult|Senior|Male|Female)/gi, '').trim();
      const isCat = p.url.includes('/cat/') || /domestic|shorthair|longhair/i.test(p.altText);
      return { name: p.name, species: isCat ? 'Cat' : 'Dog', breed: breed || 'Mixed Breed', age: ageM?.[1] || 'Unknown', gender: genM?.[1] || 'Unknown', bio: '', photo: p.photo || null, url: p.url };
    });
  } catch (err) {
    console.error(`  ERR: ${err.message}`);
    try { saveDiag(`${shelterKey}-err`, await page.content()); } catch {}
    await page.close();
    return [];
  }
}

// ═══ LINCOLN COUNTY (furrypets.com) ═══
async function scrapeLincoln(browser) {
  const PAGES = [
    { url: 'https://furrypets.com/adopt/adopt-dogs/', species: 'Dog', age: 'Adult' },
    { url: 'https://furrypets.com/adopt/adopt-puppies/', species: 'Dog', age: 'Puppy' },
    { url: 'https://furrypets.com/adopt/adopt-cats/', species: 'Cat', age: 'Adult' },
    { url: 'https://furrypets.com/adopt/adopt-kittens/', species: 'Cat', age: 'Kitten' },
  ];
  let allPets = [];

  for (const pg of PAGES) {
    console.log(`\n[lincoln] ${pg.url}`);
    const page = await newPage(browser, false);

    try {
      await page.goto(pg.url, { waitUntil: 'networkidle0', timeout: 60000 });

      // Try to find content
      for (const sel of ['.fusion-portfolio-post', 'article.post', '.post-card', 'figure']) {
        try { await page.waitForSelector(sel, { timeout: 5000 }); console.log(`    OK: ${sel}`); break; } catch {}
      }

      // Scroll to trigger lazy load
      await page.evaluate(async () => {
        for (let i = 0; i < document.body.scrollHeight; i += 400) {
          window.scrollTo(0, i);
          await new Promise(r => setTimeout(r, 200));
        }
      });
      await new Promise(r => setTimeout(r, 3000));

      const pets = await page.evaluate((species, age) => {
        const results = [];
        const seen = new Set();

        // Strategy 1: Fusion portfolio posts
        document.querySelectorAll('.fusion-portfolio-post').forEach(el => {
          const t = el.querySelector('h2, h3, h4, .entry-title')?.textContent?.trim();
          const img = el.querySelector('img:not([src*="logo"])');
          const link = el.querySelector('a[href]');
          const src = img?.src || img?.dataset?.src || img?.dataset?.orig || '';
          if (t && t.length > 1 && t.length < 60 && !seen.has(t) && !src.includes('data:image/gif')) {
            seen.add(t);
            results.push({ name: t, species, breed: '', age, gender: '', bio: '', photo: src || null, url: link?.href || '' });
          }
        });

        // Strategy 2: any article/post
        if (results.length === 0) {
          document.querySelectorAll('article, .post, .type-post').forEach(el => {
            const t = el.querySelector('h2, h3, .entry-title')?.textContent?.trim();
            const img = el.querySelector('img:not([src*="logo"])');
            const link = el.querySelector('a[href]');
            if (t && t.length > 1 && t.length < 60 && !seen.has(t)) {
              seen.add(t);
              results.push({ name: t, species, breed: '', age, gender: '', bio: '', photo: img?.src || null, url: link?.href || '' });
            }
          });
        }

        // Strategy 3: content images
        if (results.length === 0) {
          document.querySelectorAll('img[alt]').forEach(img => {
            const src = img.src || '';
            const alt = (img.alt || '').trim();
            if (src.includes('wp-content/uploads') && !src.includes('logo') && alt.length > 1 && alt.length < 60 && !seen.has(alt)) {
              seen.add(alt);
              results.push({ name: alt, species, breed: '', age, gender: '', bio: '', photo: src, url: img.closest('a')?.href || '' });
            }
          });
        }

        return results;
      }, pg.species, pg.age);

      console.log(`    Found ${pets.length}`);
      if (pets.length === 0) saveDiag(`lincoln-${pg.species.toLowerCase()}-${pg.age.toLowerCase()}`, await page.content());
      allPets.push(...pets);
    } catch (err) {
      console.error(`    ERR: ${err.message}`);
    }
    await page.close();
  }

  const u = new Map();
  allPets.forEach(p => { if (!u.has(p.name)) u.set(p.name, p); });
  const result = Array.from(u.values());
  console.log(`  [lincoln] TOTAL: ${result.length}`);
  return result;
}

// ═══ NLPAC ═══
async function scrapeNlpac(browser) {
  const url = 'https://www.nlpac.com/pets';
  console.log(`\n[nlpac] ${url}`);
  const page = await newPage(browser, false);

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));

    const petLinks = await page.evaluate(() => {
      const links = [];
      const seen = new Set();
      document.querySelectorAll('a[href*="/q/pets/"], a[href*="/pets/"]').forEach(a => {
        const href = a.href;
        if (seen.has(href) || !href) return;
        const parts = new URL(href).pathname.split('/').filter(Boolean);
        if (parts.length < 3) return;
        seen.add(href);
        links.push({ href });
      });
      return links;
    });

    await page.close();
    console.log(`  Found ${petLinks.length} pet links`);

    if (petLinks.length === 0) {
      const p2 = await newPage(browser, false);
      await p2.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      saveDiag('nlpac-list', await p2.content());
      await p2.close();
      return [];
    }

    const allPets = [];
    for (const link of petLinks) {
      const dp = await newPage(browser, false);
      try {
        await dp.goto(link.href, { waitUntil: 'networkidle2', timeout: 20000 });
        await new Promise(r => setTimeout(r, 1500));

        const pet = await dp.evaluate((pageUrl) => {
          const name = (document.querySelector('h1')?.textContent || '').replace('Meet ', '').trim();
          const img = document.querySelector('img[src*="custompages"], img[src*="bizcategories"]');
          const photo = img?.src || null;

          const info = {};
          document.querySelectorAll('li').forEach(li => {
            const m = li.textContent.trim().match(/^(.+?):\s*(.+)$/);
            if (m) info[m[1].trim()] = m[2].trim();
          });

          let bio = '';
          document.querySelectorAll('p').forEach(p => {
            const t = p.textContent.trim();
            if (t.length > 40 && !bio && !t.includes('Contact') && !t.includes('©') && !t.includes('Address')) bio = t;
          });

          const at = (info['Animal Type'] || '').toLowerCase();
          const breed = info['Breed'] || '';
          let species = 'Dog';
          if (at.includes('cat')) species = 'Cat';
          else if (at.includes('guinea') || breed.toLowerCase().includes('guinea')) species = 'Other';

          return { name, species, breed, age: info['Age'] || '', gender: '', bio: bio.substring(0, 300), photo, url: pageUrl };
        }, link.href);

        if (pet.name) {
          console.log(`    OK: ${pet.name} (${pet.species})`);
          allPets.push(pet);
        }
      } catch (err) {
        console.error(`    ERR ${link.href}: ${err.message}`);
      }
      await dp.close();
    }

    console.log(`  [nlpac] TOTAL: ${allPets.length}`);
    return allPets;
  } catch (err) {
    console.error(`  ERR: ${err.message}`);
    await page.close();
    return [];
  }
}

// ═══ MAIN ═══
async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  WP&R Pet Data Builder v2                       ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-web-security']
  });

  const data = { lastUpdated: new Date().toISOString(), shelters: {} };

  data.shelters.marathon = await scrapeAdoptapet(browser, '77626-humane-society-of-marathon-county-wausau-wisconsin', 'marathon');
  data.shelters.clark = await scrapePetfinder(browser, 'WI34', 'clark');
  data.shelters.adams = await scrapeAdoptapet(browser, '76343-adams-county-humane-society-friendship-wisconsin', 'adams');
  data.shelters.lincoln = await scrapeLincoln(browser);
  data.shelters.nlpac = await scrapeNlpac(browser);

  await browser.close();

  // Summary
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  RESULTS                                        ║');
  console.log('╠══════════════════════════════════════════════════╣');
  let total = 0;
  for (const [key, pets] of Object.entries(data.shelters)) {
    const d = pets.filter(p => p.species === 'Dog').length;
    const c = pets.filter(p => p.species === 'Cat').length;
    const o = pets.filter(p => p.species === 'Other').length;
    console.log(`║  ${key.padEnd(12)} ${String(pets.length).padStart(3)} pets (${d}D ${c}C ${o}O)`.padEnd(51) + '║');
    total += pets.length;
  }
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  TOTAL: ${total} pets`.padEnd(51) + '║');
  console.log('╚══════════════════════════════════════════════════╝');

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2));
  console.log(`\n✅ Saved to ${OUTPUT_FILE}`);
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
