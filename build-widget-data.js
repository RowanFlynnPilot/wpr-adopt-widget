/**
 * WP&R Adoptable Pets — Data Builder v5.1
 *
 * v5.1 fix: Adoptapet photos
 *   - Try img.src, img.getAttribute('src'), img.dataset.src, img.srcset
 *   - Log first image's raw src for debugging
 *   - Extract Cloudinary ID from any available attribute
 *   - Also try: scrape the "Learn More" card's expanded section which
 *     sometimes has a different img with the full src
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
  fs.writeFileSync(file, html.substring(0, 100000));
  console.log(`    [diag] docs/diag-${name}.html`);
}

async function makePage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1280, height: 900 });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {} };
  });
  return page;
}

// ═══════════════════════════════════════════════════════
// ADOPTAPET — click-through pagination + photo fix
// ═══════════════════════════════════════════════════════
async function scrapeAdoptapet(browser, shelterId, shelterKey) {
  const url = `https://www.adoptapet.com/shelter/${shelterId}/available-pets`;
  console.log(`\n[${shelterKey}] Adoptapet: ${url}`);

  const page = await makePage(browser);
  let allPets = [];
  let totalExpected = 0;

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    try {
      await page.waitForSelector('img[alt^="Photo of"]', { timeout: 20000 });
      console.log('    OK: pet images rendered');
    } catch {
      console.log('    WARN: no pet images after 20s');
      await new Promise(r => setTimeout(r, 8000));
      const count = await page.evaluate(() => document.querySelectorAll('img[alt^="Photo of"]').length);
      if (count === 0) {
        console.log('    FAIL: no pet images');
        saveDiag(`${shelterKey}-initial`, await page.content());
        await page.close();
        return [];
      }
    }

    // Debug: log raw src attributes of first few images
    const debugSrcs = await page.evaluate(() => {
      const imgs = document.querySelectorAll('img[alt^="Photo of"]');
      const results = [];
      imgs.forEach((img, i) => {
        if (i < 3) {
          results.push({
            alt: img.alt,
            src: img.src,
            getSrc: img.getAttribute('src'),
            dataSrc: img.dataset?.src || '',
            srcset: img.srcset || img.getAttribute('srcset') || '',
            outerSnippet: img.outerHTML.substring(0, 300)
          });
        }
      });
      return results;
    });
    console.log('    DEBUG - First image attributes:');
    debugSrcs.forEach((d, i) => {
      console.log(`      [${i}] alt: ${d.alt}`);
      console.log(`          src: ${d.src?.substring(0, 120)}`);
      console.log(`          getAttribute: ${d.getSrc?.substring(0, 120)}`);
      console.log(`          data-src: ${d.dataSrc?.substring(0, 120)}`);
      console.log(`          srcset: ${d.srcset?.substring(0, 120)}`);
      console.log(`          html: ${d.outerSnippet?.substring(0, 200)}`);
    });

    let pageNum = 1;
    while (pageNum <= 12) {
      console.log(`  Scraping page ${pageNum}...`);

      const result = await page.evaluate(() => {
        const pets = [];
        const seen = new Set();

        document.querySelectorAll('img[alt^="Photo of"]').forEach(img => {
          const link = img.closest('a[href*="/pet/"]');
          if (!link) return;
          const href = link.href;
          if (seen.has(href)) return;
          seen.add(href);

          const name = (img.alt || '').replace(/^Photo of\s*/i, '').trim();
          if (!name || name.length > 60) return;

          // Try every possible source for the image URL
          const rawSrc = img.getAttribute('src') || img.src || '';
          const dataSrc = img.dataset?.src || img.getAttribute('data-src') || '';
          const srcset = img.srcset || img.getAttribute('srcset') || '';
          
          // Check all possible sources for a Cloudinary image ID
          let photo = null;
          const allSrcs = [rawSrc, dataSrc, srcset];
          
          for (const s of allSrcs) {
            if (!s) continue;
            // Match the numeric ID at end of Adoptapet Cloudinary URLs
            // Pattern: f_auto,q_auto/1292568064  or  q_auto/1292568064
            const idMatch = s.match(/q_auto\/(\d{8,})/);
            if (idMatch && !s.includes('NoPetPhoto') && !s.includes('badge') && !s.includes('hero')) {
              photo = `https://media.adoptapet.com/image/upload/c_auto,g_auto,w_400,ar_4:3,dpr_2/f_auto,q_auto/${idMatch[1]}`;
              break;
            }
          }
          
          // Fallback: try to find ANY numeric ID in the src that's 8+ digits
          if (!photo && rawSrc && !rawSrc.includes('NoPetPhoto')) {
            const fallbackMatch = rawSrc.match(/\/(\d{8,})(?:\.|\/|$)/);
            if (fallbackMatch) {
              photo = `https://media.adoptapet.com/image/upload/c_auto,g_auto,w_400,ar_4:3,dpr_2/f_auto,q_auto/${fallbackMatch[1]}`;
            }
          }

          // Parse text content for breed/gender/age
          const fullText = link.textContent || '';
          const firstIdx = fullText.indexOf(name);
          let textAfterName = '';
          if (firstIdx >= 0) {
            const secondIdx = fullText.indexOf(name, firstIdx + name.length);
            textAfterName = secondIdx >= 0
              ? fullText.substring(secondIdx + name.length)
              : fullText.substring(firstIdx + name.length);
          }

          const genderAgeMatch = textAfterName.match(/(Male|Female),\s*(.+?)(?=[A-Z][a-z]+,\s*[A-Z]{2})/);
          let breed = '', gender = '', age = '';
          if (genderAgeMatch) {
            gender = genderAgeMatch[1];
            age = genderAgeMatch[2].trim();
            breed = textAfterName.substring(0, genderAgeMatch.index).trim();
          } else {
            breed = textAfterName.replace(/(?:Male|Female).*$/i, '').trim();
            const gm = textAfterName.match(/(Male|Female)/i);
            if (gm) gender = gm[1];
          }

          const bl = breed.toLowerCase();
          const isCat = bl.includes('shorthair') || bl.includes('longhair') || bl.includes('mediumhair') ||
                        bl.includes('siamese') || bl.includes('tabby') || bl.includes('calico') ||
                        bl.includes('persian') || bl.includes('bengal') || bl.includes('ragdoll') ||
                        href.endsWith('-cat');

          pets.push({ name, breed, age, gender, photo, url: href, species: isCat ? 'Cat' : 'Dog' });
        });

        const cm = document.body.innerText.match(/(\d+)\s*-\s*(\d+)\s+of\s+(\d+)/);
        
        // Find next page button
        let hasNextPage = false;
        let nextPageNum = 0;
        if (cm) {
          const perPage = parseInt(cm[2]) - parseInt(cm[1]) + 1;
          nextPageNum = Math.ceil(parseInt(cm[2]) / perPage) + 1;
          const allBtns = [...document.querySelectorAll('button, a, [role="button"]')];
          hasNextPage = allBtns.some(btn => btn.textContent.trim() === String(nextPageNum) && !btn.disabled);
        }

        return { pets, totalPets: cm ? parseInt(cm[3]) : 0, hasNextPage, nextPageNum };
      });

      let newCount = 0;
      for (const pet of result.pets) {
        if (!allPets.find(p => p.url === pet.url)) {
          allPets.push(pet);
          newCount++;
        }
      }

      if (pageNum === 1 && result.totalPets > 0) totalExpected = result.totalPets;

      const photosOnPage = result.pets.filter(p => p.photo).length;
      console.log(`    Found ${result.pets.length} on page, ${newCount} new, ${photosOnPage} with photos (total ${allPets.length}${totalExpected ? '/' + totalExpected : ''})`);

      if (result.pets.length > 0) {
        const s = result.pets[0];
        console.log(`    Sample: ${s.name} | ${s.breed} | ${s.gender}, ${s.age} | photo: ${s.photo ? 'YES' : 'no'}`);
      }

      if (newCount === 0) { console.log('    No new pets, stopping'); break; }
      if (totalExpected > 0 && allPets.length >= totalExpected) { console.log('    Got all expected, stopping'); break; }
      if (!result.hasNextPage) { console.log('    No next page button, stopping'); break; }

      console.log(`    Clicking page ${result.nextPageNum}...`);
      const clicked = await page.evaluate((n) => {
        const btns = [...document.querySelectorAll('button, a, [role="button"]')];
        for (const b of btns) {
          if (b.textContent.trim() === String(n) && !b.disabled) { b.click(); return true; }
        }
        return false;
      }, result.nextPageNum);

      if (!clicked) { console.log('    Could not click next, stopping'); break; }

      await new Promise(r => setTimeout(r, 3000));
      try {
        await page.waitForFunction(
          (prevStart) => {
            const m = document.body.innerText.match(/(\d+)\s*-\s*\d+\s+of\s+\d+/);
            return m && parseInt(m[1]) !== prevStart;
          },
          { timeout: 10000 },
          (pageNum - 1) * 9 + 1
        );
      } catch {
        await new Promise(r => setTimeout(r, 3000));
      }

      pageNum++;
    }
  } catch (err) {
    console.error(`    ERR: ${err.message}`);
    try { saveDiag(`${shelterKey}-error`, await page.content()); } catch {}
  }

  await page.close();
  console.log(`  [${shelterKey}] TOTAL: ${allPets.length} unique pets, ${allPets.filter(p => p.photo).length} with photos`);

  return allPets.map(p => ({
    name: p.name, species: p.species, breed: p.breed || 'Unknown',
    age: p.age || 'Unknown', gender: p.gender || 'Unknown',
    bio: '', photo: p.photo, url: p.url
  }));
}

// ═══════════════════════════════════════════════════════
// PETFINDER (Clark County) — unchanged
// ═══════════════════════════════════════════════════════
async function scrapePetfinder(browser, shelterKey) {
  const url = 'https://www.petfinder.com/member/us/wi/neillsville/clark-county-humane-society-wi34/';
  console.log(`\n[${shelterKey}] Petfinder: ${url}`);
  const page = await makePage(browser);
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    try { await page.waitForSelector('a[href*="/details/"]', { timeout: 15000 }); console.log('    OK: pet links found'); }
    catch { await new Promise(r => setTimeout(r, 8000)); }

    const pets = await page.evaluate(() => {
      const results = [], seen = new Set();
      document.querySelectorAll('a[href*="/details/"]').forEach(link => {
        const href = link.href;
        if (seen.has(href)) return; seen.add(href);
        const img = link.querySelector('img');
        if (!img) return;
        const alt = img.alt || '', src = img.src || '';
        const name = alt.split(',')[0]?.trim();
        if (!name || name.length > 60 || name.length < 2) return;
        results.push({ name, altText: alt, photo: src, url: href });
      });
      return results;
    });
    console.log(`  Found ${pets.length} pets`);
    if (pets.length === 0) saveDiag(`${shelterKey}-pf`, await page.content());
    await page.close();

    return pets.map(p => {
      const parts = (p.altText || '').split(',').map(s => s.trim());
      const desc = parts[2] || '';
      const ageM = desc.match(/(Baby|Puppy|Kitten|Young|Adult|Senior)/i);
      const genM = desc.match(/(Male|Female)/i);
      const breed = desc.replace(/(Baby|Puppy|Kitten|Young|Adult|Senior|Male|Female)/gi, '').replace(/\.$/, '').trim();
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

// ═══════════════════════════════════════════════════════
// NLPAC — unchanged
// ═══════════════════════════════════════════════════════
async function scrapeNlpac(browser) {
  const url = 'https://www.nlpac.com/pets';
  console.log(`\n[nlpac] ${url}`);
  const page = await makePage(browser);
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));
    const pets = await page.evaluate(() => {
      const results = [], seen = new Set();
      document.querySelectorAll('a[href*="/q/pets/"]').forEach(a => {
        const href = a.href;
        if (seen.has(href) || !href) return;
        const parts = new URL(href).pathname.split('/').filter(Boolean);
        if (parts.length < 3) return;
        seen.add(href);
        const slug = parts[parts.length - 1];
        const name = slug.replace(/\d+$/, '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
        const container = a.closest('div') || a.parentElement;
        const img = container?.querySelector('img') || a.querySelector('img');
        const photo = (img?.src && !img.src.includes('logo')) ? img.src : null;
        results.push({ name, photo, url: href });
      });
      return results;
    });
    console.log(`  Found ${pets.length} pet links`);
    if (pets.length === 0) saveDiag('nlpac-list', await page.content());
    await page.close();
    return pets.map(p => ({ name: p.name, species: 'Dog', breed: '', age: '', gender: '', bio: '', photo: p.photo, url: p.url }));
  } catch (err) {
    console.error(`  ERR: ${err.message}`);
    await page.close();
    return [];
  }
}

// ═══════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════
async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  WP&R Pet Data Builder v5.1                     ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-blink-features=AutomationControlled']
  });

  const data = { lastUpdated: new Date().toISOString(), shelters: {} };

  data.shelters.marathon = await scrapeAdoptapet(browser, '77626-humane-society-of-marathon-county-wausau-wisconsin', 'marathon');
  data.shelters.clark = await scrapePetfinder(browser, 'clark');
  data.shelters.adams = await scrapeAdoptapet(browser, '76343-adams-county-humane-society-friendship-wisconsin', 'adams');
  data.shelters.lincoln = [];
  data.shelters.nlpac = await scrapeNlpac(browser);

  await browser.close();

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  RESULTS                                        ║');
  console.log('╠══════════════════════════════════════════════════╣');
  let total = 0;
  for (const [key, pets] of Object.entries(data.shelters)) {
    const d = pets.filter(p => p.species === 'Dog').length;
    const c = pets.filter(p => p.species === 'Cat').length;
    const ph = pets.filter(p => p.photo).length;
    console.log(`║  ${key.padEnd(12)} ${String(pets.length).padStart(3)} pets (${d}D ${c}C) ${ph} photos`.padEnd(51) + '║');
    total += pets.length;
  }
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  TOTAL: ${total} pets`.padEnd(51) + '║');
  console.log('╚══════════════════════════════════════════════════╝');

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2));
  console.log(`\n✅ Saved to ${OUTPUT_FILE}`);
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
