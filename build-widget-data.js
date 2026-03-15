/**
 * WP&R Adoptable Pets — Data Builder v5
 *
 * v5 fixes:
 *   - Adoptapet: pagination is CLIENT-SIDE React — must click "next" button
 *     instead of changing URL params (which returned same page every time)
 *   - Adoptapet: stealth mode — override navigator.webdriver to avoid detection
 *   - Adoptapet: images load so we can get photo URLs from img.src
 *   - Added delay between pagination clicks to let React re-render
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
  
  // Stealth: hide headless indicators
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {} };
  });
  
  return page;
}

// ═══════════════════════════════════════════════════════
// ADOPTAPET SCRAPER — click-through pagination
// ═══════════════════════════════════════════════════════
async function scrapeAdoptapet(browser, shelterId, shelterKey) {
  const url = `https://www.adoptapet.com/shelter/${shelterId}/available-pets`;
  console.log(`\n[${shelterKey}] Adoptapet: ${url}`);
  
  const page = await makePage(browser);
  let allPets = [];
  let totalExpected = 0;

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    // Wait for initial pet cards
    try {
      await page.waitForSelector('img[alt^="Photo of"]', { timeout: 20000 });
      console.log('    OK: initial pet images rendered');
    } catch {
      console.log('    WARN: no pet images after 20s, trying extra wait...');
      await new Promise(r => setTimeout(r, 8000));
      const count = await page.evaluate(() => document.querySelectorAll('img[alt^="Photo of"]').length);
      if (count === 0) {
        console.log('    FAIL: no pet images found at all');
        saveDiag(`${shelterKey}-initial`, await page.content());
        await page.close();
        return [];
      }
    }

    // Scrape current page and paginate by clicking buttons
    let pageNum = 1;
    const MAX_PAGES = 12;

    while (pageNum <= MAX_PAGES) {
      console.log(`  Scraping page ${pageNum}...`);
      
      // Extract pets from current view
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

          // Photo URL
          const src = img.src || img.getAttribute('src') || '';
          let photo = null;
          if (src.includes('adoptapet.com') && !src.includes('NoPetPhoto')) {
            const idMatch = src.match(/f_auto,q_auto\/(\d+)/);
            if (idMatch) {
              photo = `https://media.adoptapet.com/image/upload/c_auto,g_auto,w_400,ar_4:3,dpr_2/f_auto,q_auto/${idMatch[1]}`;
            }
          }

          // Parse text
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

        // Total: "1 - 9 of 62 pets available"
        const cm = document.body.innerText.match(/(\d+)\s*-\s*(\d+)\s+of\s+(\d+)/);
        
        // Find the next page button — look for pagination buttons
        // Adoptapet uses numbered page buttons: 1, 2, 3, ..., and also "next" arrows
        const currentPageNum = cm ? Math.ceil(parseInt(cm[2]) / (parseInt(cm[2]) - parseInt(cm[1]) + 1)) : 1;
        const nextPageNum = currentPageNum + 1;
        
        // Look for a button/link with the next page number
        let hasNextPage = false;
        const allButtons = [...document.querySelectorAll('button, a, [role="button"]')];
        for (const btn of allButtons) {
          const txt = btn.textContent.trim();
          if (txt === String(nextPageNum) && !btn.disabled) {
            hasNextPage = true;
            break;
          }
        }

        return { 
          pets, 
          totalPets: cm ? parseInt(cm[3]) : 0,
          hasNextPage,
          nextPageNum
        };
      });

      // Collect unique pets
      let newCount = 0;
      for (const pet of result.pets) {
        if (!allPets.find(p => p.url === pet.url)) {
          allPets.push(pet);
          newCount++;
        }
      }

      if (pageNum === 1 && result.totalPets > 0) {
        totalExpected = result.totalPets;
      }

      console.log(`    Found ${result.pets.length} on page, ${newCount} new (total ${allPets.length}${totalExpected ? '/' + totalExpected : ''})`);
      
      if (result.pets.length > 0) {
        const sample = result.pets[0];
        console.log(`    Sample: ${sample.name} | ${sample.breed} | ${sample.gender}, ${sample.age} | photo: ${sample.photo ? 'YES' : 'no'}`);
      }

      // Stop if no new pets or got all expected
      if (newCount === 0) {
        console.log('    No new pets found, stopping');
        break;
      }
      if (totalExpected > 0 && allPets.length >= totalExpected) {
        console.log('    Got all expected pets, stopping');
        break;
      }

      // Click next page button
      if (!result.hasNextPage) {
        console.log('    No next page button found, stopping');
        break;
      }

      console.log(`    Clicking page ${result.nextPageNum}...`);
      
      const clicked = await page.evaluate((nextNum) => {
        const allBtns = [...document.querySelectorAll('button, a, [role="button"]')];
        for (const btn of allBtns) {
          if (btn.textContent.trim() === String(nextNum) && !btn.disabled) {
            btn.click();
            return true;
          }
        }
        return false;
      }, result.nextPageNum);

      if (!clicked) {
        console.log('    Could not click next button, stopping');
        break;
      }

      // Wait for new content to load
      await new Promise(r => setTimeout(r, 3000));
      
      // Wait for the page count text to update
      try {
        await page.waitForFunction(
          (prevTotal) => {
            const text = document.body.innerText;
            const m = text.match(/(\d+)\s*-\s*(\d+)\s+of\s+(\d+)/);
            if (!m) return false;
            return parseInt(m[1]) !== prevTotal;
          },
          { timeout: 10000 },
          (pageNum - 1) * 9 + 1 // previous page's start number
        );
        console.log('    Page content updated');
      } catch {
        console.log('    WARN: page content may not have updated, continuing anyway');
        await new Promise(r => setTimeout(r, 3000));
      }

      pageNum++;
    }

  } catch (err) {
    console.error(`    ERR: ${err.message}`);
    try { saveDiag(`${shelterKey}-error`, await page.content()); } catch {}
  }

  await page.close();

  console.log(`  [${shelterKey}] TOTAL: ${allPets.length} unique pets`);

  return allPets.map(p => ({
    name: p.name,
    species: p.species,
    breed: p.breed || 'Unknown',
    age: p.age || 'Unknown',
    gender: p.gender || 'Unknown',
    bio: '',
    photo: p.photo,
    url: p.url
  }));
}

// ═══════════════════════════════════════════════════════
// PETFINDER (Clark County) — unchanged from v4
// ═══════════════════════════════════════════════════════
async function scrapePetfinder(browser, shelterKey) {
  const url = 'https://www.petfinder.com/member/us/wi/neillsville/clark-county-humane-society-wi34/';
  console.log(`\n[${shelterKey}] Petfinder: ${url}`);
  const page = await makePage(browser);

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    try {
      await page.waitForSelector('a[href*="/details/"]', { timeout: 15000 });
      console.log('    OK: pet links found');
    } catch {
      console.log('    WARN: no pet links, extra wait...');
      await new Promise(r => setTimeout(r, 8000));
    }

    const pets = await page.evaluate(() => {
      const results = [];
      const seen = new Set();
      document.querySelectorAll('a[href*="/details/"]').forEach(link => {
        const href = link.href;
        if (seen.has(href)) return;
        seen.add(href);
        const img = link.querySelector('img');
        if (!img) return;
        const alt = img.alt || '';
        const src = img.src || '';
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
// NLPAC — unchanged from v4
// ═══════════════════════════════════════════════════════
async function scrapeNlpac(browser) {
  const url = 'https://www.nlpac.com/pets';
  console.log(`\n[nlpac] ${url}`);
  const page = await makePage(browser);

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));

    const pets = await page.evaluate(() => {
      const results = [];
      const seen = new Set();
      document.querySelectorAll('a[href*="/q/pets/"], a[href*="/pets/"]').forEach(a => {
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
    try { saveDiag('nlpac-err', await page.content()); } catch {}
    await page.close();
    return [];
  }
}

// ═══════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════
async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  WP&R Pet Data Builder v5                       ║');
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
    const photos = pets.filter(p => p.photo).length;
    console.log(`║  ${key.padEnd(12)} ${String(pets.length).padStart(3)} pets (${d}D ${c}C) ${photos} photos`.padEnd(51) + '║');
    total += pets.length;
  }
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  TOTAL: ${total} pets`.padEnd(51) + '║');
  console.log('╚══════════════════════════════════════════════════╝');

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2));
  console.log(`\n✅ Saved to ${OUTPUT_FILE}`);
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
