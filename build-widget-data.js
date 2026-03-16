/**
 * Wausau Pilot & Review — Adoptable Pets Data Builder
 * 
 * Scrapes/fetches pet data from all four shelters and outputs
 * a single JSON file that the widget can consume.
 * 
 * Data sources:
 *   - Marathon County HS → Adoptapet.com (HTML scrape)
 *   - Clark County HS → Petfinder.com (HTML scrape)  
 *   - Adams County HS → Adoptapet.com (HTML scrape)
 *   - Lincoln County HS → Adoptapet.com (same as Marathon/Adams; they list there)
 * 
 * Usage:
 *   npm install
 *   node build-widget-data.js
 * 
 * Output:
 *   pet-data.json — Complete pet data for the widget
 * 
 * For GitHub Actions automation, see the workflow file.
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const OUTPUT_FILE = path.join(__dirname, 'pet-data.json');
const DIAG_DIR = path.join(__dirname, 'docs');

// Realistic Chrome UA to reduce bot detection (sites often block headless)
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function ensureDiagDir() {
  if (!fs.existsSync(DIAG_DIR)) fs.mkdirSync(DIAG_DIR, { recursive: true });
}

function saveDiag(name, html) {
  ensureDiagDir();
  const file = path.join(DIAG_DIR, `diag-${name}.html`);
  fs.writeFileSync(file, (html || '').substring(0, 500000));
  console.log(`    [diag] Saved docs/diag-${name}.html — open to see what the page actually returned`);
}

/** Create a page with stealth-ish settings to reduce bot blocks */
async function makePage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  await page.setViewport({ width: 1280, height: 900 });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    if (typeof window.chrome === 'undefined') window.chrome = { runtime: {} };
  });
  return page;
}

// ─── ADOPTAPET SCRAPER ───
// Adoptapet uses client-side pagination (Next/numbered buttons). URL ?page=N is ignored,
// so we must use one page, scrape, click next, wait for update, repeat.
async function scrapeAdoptapet(browser, shelterId, shelterKey) {
  const baseUrl = `https://www.adoptapet.com/shelter/${shelterId}`;
  const url = `${baseUrl}/available-pets`;
  console.log(`\n[${shelterKey}] Scraping Adoptapet: ${url}`);

  const page = await makePage(browser);
  let allPets = [];
  let totalExpected = 0;
  const MAX_PAGES = 15;  // Safety limit
  let pageNum = 1;

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 5000));

    // Wait for pet content to appear
    try {
      await page.waitForSelector('a[href*="/pet/"]', { timeout: 20000 });
    } catch {
      await new Promise(r => setTimeout(r, 5000));
      const petCount = await page.evaluate(() => document.querySelectorAll('a[href*="/pet/"]').length);
      if (petCount === 0) {
        saveDiag(`${shelterKey}-adoptapet`, await page.content());
      }
    }

    while (pageNum <= MAX_PAGES) {
      console.log(`  Page ${pageNum}...`);

      const result = await page.evaluate(() => {
        const pets = [];
        document.querySelectorAll('a[href*="/pet/"]').forEach(card => {
          const img = card.querySelector('img');
          const href = card.href;

          if (!href || !href.includes('/pet/') || href.includes('blog')) return;

          const textLines = card.textContent.trim().split('\n').map(s => s.trim()).filter(Boolean);
          const name = textLines[0] || '';
          const breed = textLines[1] || '';
          const details = textLines[2] || '';

          if (name && name.length < 50 && !name.includes('Learn More') && !name.includes('Color')) {
            pets.push({ name, breed, details, photo: img?.src || null, url: href });
          }
        });

        // Pagination: "1 - 9 of 62" or "10 - 18 of 62" (or "1-9 of 62")
        const countText = document.body.innerText.match(/(\d+)\s*-\s*(\d+)\s+of\s+(\d+)/);
        let totalPets = 0, hasNextPage = false, nextPageNum = 0, rangeStart = 0;
        const candidates = [...document.querySelectorAll('button, a, [role="button"], [aria-label]')];
        if (countText) {
          totalPets = parseInt(countText[3], 10);
          rangeStart = parseInt(countText[1], 10);
          const rangeEnd = parseInt(countText[2], 10);
          const perPage = rangeEnd - rangeStart + 1;
          nextPageNum = Math.floor(rangeEnd / perPage) + 1;
          const nextBtn = candidates.find(el => el.textContent.trim() === String(nextPageNum) && !el.disabled);
          const nextLink = candidates.find(el =>
            /^next$/i.test(el.textContent.trim()) || (el.getAttribute('aria-label') || '').toLowerCase().includes('next')
          );
          hasNextPage = !!nextBtn || !!nextLink;
        } else {
          // No "X - Y of Z" text: still try to go next if we see a "2" or "Next" (site may have changed copy)
          const hasTwo = candidates.some(el => el.textContent.trim() === '2' && !el.disabled);
          const hasNext = candidates.some(el =>
            /^next$/i.test(el.textContent.trim()) || (el.getAttribute('aria-label') || '').toLowerCase().includes('next')
          );
          hasNextPage = hasTwo || hasNext;
          nextPageNum = 2;
        }

        return { pets, totalPets, hasNextPage, nextPageNum, rangeStart };
      });

      const newPets = result.pets.filter(p => !allPets.some(ex => ex.url === p.url));
      allPets.push(...newPets);
      if (pageNum === 1 && result.totalPets > 0) totalExpected = result.totalPets;

      console.log(`    Found ${result.pets.length} on page, ${newPets.length} new (total ${allPets.length}${totalExpected ? '/' + totalExpected : ''})`);

      if (result.pets.length === 0) {
        if (pageNum === 1) saveDiag(`${shelterKey}-adoptapet`, await page.content());
        break;
      }
      if (totalExpected > 0 && allPets.length >= totalExpected) break;
      if (!result.hasNextPage) break;

      const prevRangeStart = result.rangeStart;
      const clicked = await page.evaluate((n) => {
        const candidates = [...document.querySelectorAll('button, a, [role="button"], [aria-label]')];
        const byNum = candidates.find(el => el.textContent.trim() === String(n) && !el.disabled);
        if (byNum) { byNum.click(); return true; }
        const byNext = candidates.find(el =>
          /^next$/i.test(el.textContent.trim()) || (el.getAttribute('aria-label') || '').toLowerCase().includes('next')
        );
        if (byNext && !byNext.disabled) { byNext.click(); return true; }
        return false;
      }, result.nextPageNum);

      if (!clicked) {
        console.log('    Could not click next page, stopping');
        break;
      }

      await new Promise(r => setTimeout(r, 2500));
      try {
        await page.waitForFunction(
          (prevStart) => {
            const m = document.body.innerText.match(/(\d+)\s*-\s*\d+\s+of\s+\d+/);
            return m && parseInt(m[1], 10) > prevStart;
          },
          { timeout: 12000 },
          prevRangeStart
        );
      } catch {
        await new Promise(r => setTimeout(r, 3000));
      }

      pageNum++;
    }
  } catch (err) {
    console.error(`  Error: ${err.message}`);
    try { saveDiag(`${shelterKey}-adoptapet-error`, await page.content()); } catch (_) {}
  } finally {
    await page.close();
  }

  console.log(`  [${shelterKey}] TOTAL: ${allPets.length} pets scraped`);
  
  // Deduplicate by URL
  const unique = new Map();
  allPets.forEach(p => { if (!unique.has(p.url)) unique.set(p.url, p); });
  allPets = Array.from(unique.values());
  
  // Transform to standard format
  return allPets.map(p => {
    const detailParts = p.details.split(',').map(s => s.trim());
    const gender = detailParts.find(s => /male|female/i.test(s)) || '';
    const age = detailParts.find(s => /yr|mo|wk/i.test(s)) || '';
    
    let photo = p.photo;
    if (photo && photo.includes('adoptapet.com')) {
      photo = photo.replace(/c_auto,g_auto,w_\d+,ar_[^/]+/, 'c_auto,g_auto,w_400,ar_4:3');
      photo = photo.replace(/dpr_\d+/, 'dpr_2');
    }
    
    const isCat = p.breed?.toLowerCase().match(/shorthair|longhair|siamese|tabby|calico|persian|bengal|ragdoll/) || 
                  p.url?.match(/-cat$|-wisconsin-cat/);
    
    return {
      name: p.name,
      species: isCat ? 'Cat' : 'Dog',
      breed: p.breed || 'Unknown',
      age: age || 'Unknown',
      gender: gender || 'Unknown',
      bio: '',
      photo,
      url: p.url
    };
  });
}

// ─── PETFINDER SCRAPER ───
// Clark County's Petfinder page has pet cards with images and links
async function scrapePetfinder(browser, shelterSlug, shelterKey) {
  const url = `https://www.petfinder.com/member/us/wi/${shelterSlug}`;
  console.log(`\n[${shelterKey}] Scraping Petfinder: ${url}`);
  
  const page = await makePage(browser);
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise(r => setTimeout(r, 5000));
    
    const pets = await page.evaluate(() => {
      const results = [];
      // Petfinder pet cards are links with images and alt text
      document.querySelectorAll('a[href*="/details/"]').forEach(card => {
        const img = card.querySelector('img');
        if (!img) return;
        
        const alt = img.alt || '';
        const href = card.href;
        const name = card.textContent?.trim() || '';
        
        // Parse alt text like "Harvey, Adoptable, Adult Male Australian Cattle Dog / Blue Heeler."
        const altParts = alt.split(',').map(s => s.trim());
        const petName = altParts[0] || name;
        const ageGender = altParts[2] || '';  // "Adult Male Australian Cattle Dog"
        
        if (petName && !results.find(r => r.name === petName)) {
          results.push({
            name: petName,
            altText: alt,
            photo: img.src,
            url: href
          });
        }
      });
      return results;
    });
    
    console.log(`  Found ${pets.length} pets`);
    if (pets.length === 0) saveDiag(`${shelterKey}-petfinder`, await page.content());
    await page.close();
    
    return pets.map(p => {
      // Parse alt text: "Harvey, Adoptable, Adult Male Australian Cattle Dog / Blue Heeler."
      const parts = p.altText.split(',').map(s => s.trim());
      const descriptor = parts[2] || '';  
      const ageMatch = descriptor.match(/(Baby|Puppy|Kitten|Young|Adult|Senior)/i);
      const genderMatch = descriptor.match(/(Male|Female)/i);
      const breedPart = descriptor.replace(/(Baby|Puppy|Kitten|Young|Adult|Senior|Male|Female)/gi, '').trim();
      const speciesPart = parts.length > 2 ? parts[parts.length - 1].replace('.', '').trim() : '';
      
      const iscat = p.url.includes('/cat/') || speciesPart.toLowerCase().includes('domestic') || 
                    speciesPart.toLowerCase().includes('shorthair') || speciesPart.toLowerCase().includes('longhair');
      
      return {
        name: p.name,
        species: iscat ? 'Cat' : 'Dog',
        breed: breedPart || speciesPart || 'Unknown',
        age: ageMatch?.[1] || 'Unknown',
        gender: genderMatch?.[1] || 'Unknown',
        bio: '',
        photo: p.photo,
        url: p.url
      };
    });
    
  } catch (err) {
    console.error(`  Error: ${err.message}`);
    await page.close();
    return [];
  }
}

// ─── FURRYPETS SCRAPER (Lincoln County) ───
// Their WordPress site loads pets dynamically, needs full JS execution
async function scrapeLincoln(browser) {
  const PAGES = [
    { url: 'https://furrypets.com/adopt/adopt-dogs/', species: 'Dog', age: 'Adult' },
    { url: 'https://furrypets.com/adopt/adopt-puppies/', species: 'Dog', age: 'Puppy' },
    { url: 'https://furrypets.com/adopt/adopt-cats/', species: 'Cat', age: 'Adult' },
    { url: 'https://furrypets.com/adopt/adopt-kittens/', species: 'Cat', age: 'Kitten' },
  ];
  
  let allPets = [];
  
  for (const pg of PAGES) {
    console.log(`\n[lincoln] Scraping: ${pg.url}`);
    const page = await browser.newPage();
    
    try {
      await page.goto(pg.url, { waitUntil: 'networkidle2', timeout: 45000 });
      
      // Wait for content to load
      await new Promise(r => setTimeout(r, 8000));
      
      // Scroll to trigger lazy loading
      await page.evaluate(async () => {
        for (let i = 0; i < document.body.scrollHeight; i += 300) {
          window.scrollTo(0, i);
          await new Promise(r => setTimeout(r, 100));
        }
      });
      await new Promise(r => setTimeout(r, 3000));
      
      const pets = await page.evaluate((species, age) => {
        const results = [];
        const seen = new Set();
        
        // Try all strategies: portfolio posts, articles, cards, image galleries
        const selectors = [
          '.fusion-portfolio-post',
          'article',
          '.post-card',
          '[class*="pet"]',
          'figure',
          '.gallery-item',
          '.wp-block-image'
        ];
        
        for (const sel of selectors) {
          document.querySelectorAll(sel).forEach(el => {
            const img = el.querySelector('img:not([src*="logo"])');
            const titleEl = el.querySelector('h2, h3, h4, .entry-title');
            const link = el.querySelector('a[href]');
            const desc = el.querySelector('p, .entry-content, .excerpt');
            
            const name = (titleEl?.textContent || img?.alt || '').trim().replace(/\d+$/, '').trim();
            if (name && name.length > 1 && name.length < 60 && !seen.has(name)) {
              seen.add(name);
              const src = img?.src || img?.dataset?.src || '';
              if (src && !src.includes('data:image/gif') && !src.includes('logo')) {
                results.push({
                  name,
                  species,
                  breed: '',
                  age,
                  gender: '',
                  bio: (desc?.textContent || '').trim().substring(0, 300),
                  photo: src,
                  url: link?.href || ''
                });
              }
            }
          });
          if (results.length > 0) break;  // Use first successful strategy
        }
        
        // Fallback: grab content images with alt text
        if (results.length === 0) {
          document.querySelectorAll('img').forEach(img => {
            const src = img.src || '';
            if (src.includes('wp-content/uploads') && !src.includes('logo') && !src.includes('data:image')) {
              const name = (img.alt || '').trim().replace(/\d+$/, '').trim();
              if (name && name.length > 1 && !seen.has(name)) {
                seen.add(name);
                results.push({
                  name,
                  species,
                  breed: '',
                  age,
                  gender: '',
                  bio: '',
                  photo: src,
                  url: img.closest('a')?.href || ''
                });
              }
            }
          });
        }
        
        return results;
      }, pg.species, pg.age);
      
      console.log(`  Found ${pets.length} pets`);
      allPets.push(...pets);
      
    } catch (err) {
      console.error(`  Error: ${err.message}`);
    }
    
    await page.close();
  }
  
  // Deduplicate
  const unique = new Map();
  allPets.forEach(p => { if (!unique.has(p.name)) unique.set(p.name, p); });
  return Array.from(unique.values());
}


// ─── NLPAC SCRAPER (New Life Pet Adoption Center) ───
// Their site serves pet data in plain HTML — easy to scrape
async function scrapeNlpac(browser) {
  const url = 'https://www.nlpac.com/pets';
  console.log(`\n[nlpac] Scraping: ${url}`);
  
  const page = await makePage(browser);
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise(r => setTimeout(r, 3000));
    
    // Get pet links from the listing page
    const petLinks = await page.evaluate(() => {
      const links = [];
      document.querySelectorAll('a[href*="/q/pets/"]').forEach(a => {
        const href = a.href;
        const text = a.textContent.trim();
        if (href && !links.find(l => l.href === href) && text.includes('Learn More')) {
          // Walk up to find the pet card container
          const container = a.closest('div') || a.parentElement;
          const allText = container?.textContent || '';
          links.push({ href, text: allText.substring(0, 200) });
        }
      });
      return links;
    });
    
    if (petLinks.length === 0) saveDiag('nlpac-list', await page.content());
    await page.close();
    console.log(`  Found ${petLinks.length} pet links, fetching details...`);
    
    // Visit each pet's detail page to get full info
    const allPets = [];
    for (const link of petLinks) {
      const detailPage = await makePage(browser);
      try {
        await detailPage.goto(link.href, { waitUntil: 'networkidle2', timeout: 20000 });
        await new Promise(r => setTimeout(r, 1000));
        
        const pet = await detailPage.evaluate((pageUrl) => {
          const name = document.querySelector('h1')?.textContent?.replace('Meet ', '').trim() || '';
          const img = document.querySelector('img[src*="custompages"]');
          const photo = img?.src || null;
          
          // Parse the structured info list
          const info = {};
          document.querySelectorAll('li').forEach(li => {
            const text = li.textContent.trim();
            const match = text.match(/^(.+?):\s*(.+)$/);
            if (match) info[match[1].trim()] = match[2].trim();
          });
          
          // Get description
          const descHeader = [...document.querySelectorAll('p, div')].find(el => el.previousElementSibling?.textContent?.includes('Description'));
          let bio = '';
          const descEl = document.evaluate("//text()[contains(.,'Description')]/..", document, null, 9, null).singleNodeValue;
          if (descEl) {
            let next = descEl.nextElementSibling;
            while (next && next.tagName !== 'H2') {
              bio += next.textContent.trim() + ' ';
              next = next.nextElementSibling;
            }
          }
          // Fallback: just grab first substantial paragraph
          if (!bio) {
            document.querySelectorAll('p').forEach(p => {
              const t = p.textContent.trim();
              if (t.length > 50 && !bio && !t.includes('Contact') && !t.includes('©')) bio = t;
            });
          }
          
          const animalType = info['Animal Type'] || '';
          const breed = info['Breed'] || '';
          const age = info['Age'] || '';
          
          let species = 'Dog';
          if (animalType.toLowerCase().includes('cat')) species = 'Cat';
          else if (animalType.toLowerCase().includes('guinea') || breed.toLowerCase().includes('guinea')) species = 'Other';
          else if (animalType.toLowerCase().includes('dog')) species = 'Dog';
          
          return { name, species, breed, age, gender: '', bio: bio.trim().substring(0, 300), photo, url: pageUrl };
        }, link.href);
        
        if (pet.name) {
          console.log(`    ${pet.name} (${pet.species}) - ${pet.breed}`);
          allPets.push(pet);
        }
      } catch (err) {
        console.error(`    Error on ${link.href}: ${err.message}`);
      }
      await detailPage.close();
    }
    
    console.log(`  [nlpac] TOTAL: ${allPets.length} pets`);
    return allPets;
    
  } catch (err) {
    console.error(`  Error: ${err.message}`);
    await page.close();
    return [];
  }
}

// ─── MAIN ───
async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  Wausau Pilot & Review — Pet Data Builder       ║');
  console.log('╚══════════════════════════════════════════════════╝\n');
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,900'
    ]
  });
  
  const data = {
    lastUpdated: new Date().toISOString(),
    shelters: {}
  };
  
  // Marathon County — Adoptapet
  data.shelters.marathon = await scrapeAdoptapet(
    browser, 
    '77626-humane-society-of-marathon-county-wausau-wisconsin',
    'marathon'
  );
  
  // Clark County — Petfinder
  data.shelters.clark = await scrapePetfinder(
    browser,
    'neillsville/clark-county-humane-society-wi34',
    'clark'
  );
  
  // Adams County — Adoptapet
  data.shelters.adams = await scrapeAdoptapet(
    browser,
    '76343-adams-county-humane-society-friendship-wisconsin',
    'adams'
  );
  
  // Lincoln County — Adoptapet (they list on adoptapet.com; furrypets.com is dynamic/unreliable)
  data.shelters.lincoln = await scrapeAdoptapet(
    browser,
    '66070-lincoln-county-humane-society-merrill-wisconsin',
    'lincoln'
  );
  
  // New Life Pet Adoption Center — Direct HTML scrape
  data.shelters.nlpac = await scrapeNlpac(browser);
  
  await browser.close();
  
  // Summary
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  RESULTS                                        ║');
  console.log('╠══════════════════════════════════════════════════╣');
  let total = 0;
  for (const [key, pets] of Object.entries(data.shelters)) {
    const dogs = pets.filter(p => p.species === 'Dog').length;
    const cats = pets.filter(p => p.species === 'Cat').length;
    console.log(`║  ${key.padEnd(12)} ${String(pets.length).padStart(3)} pets (${dogs} dogs, ${cats} cats)`.padEnd(51) + '║');
    total += pets.length;
  }
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  TOTAL: ${total} pets`.padEnd(51) + '║');
  console.log('╚══════════════════════════════════════════════════╝');
  
  // Write output
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2));
  console.log(`\n✅ Saved to ${OUTPUT_FILE}`);

  // Inject built data into widget HTML so Lincoln (and all shelters) show live data without needing pet-data.json
  const widgetPath = path.join(__dirname, 'adopt-widget.html');
  if (fs.existsSync(widgetPath)) {
    let html = fs.readFileSync(widgetPath, 'utf8');
    const inject = 'const PET_DATA=' + JSON.stringify(data.shelters) + ';';
    const replaced = html.replace(/const PET_DATA=\{[\s\S]*?  \]\n\};/, inject);
    if (replaced !== html) {
      fs.writeFileSync(widgetPath, replaced);
      console.log('✅ Injected pet data into adopt-widget.html');
    }
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
