/**
 * WP&R Adoptable Pets — Data Builder v3
 *
 * v3 fixes:
 *   - Adoptapet: parse child elements (not newline-split text) for name/breed/age
 *   - Adoptapet: extract photo IDs from img src properly
 *   - Adoptapet: better pagination (checks "X of Y" count text)
 *   - Removed Lincoln County (furrypets.com too dynamic, will add back later)
 *   - NLPAC: bot-blocked on detail pages, so only scrape listing page
 *   - Clark County: try Petfinder org page directly
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

async function newPage(browser, blockMedia = false) {
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1280, height: 900 });
  if (blockMedia) {
    await page.setRequestInterception(true);
    page.on('request', req => {
      const t = req.resourceType();
      if (['font', 'media'].includes(t)) req.abort();
      else req.continue();
    });
  }
  return page;
}

// ═══════════════════════════════════════════════════════
// ADOPTAPET SCRAPER (Marathon County + Adams County)
// ═══════════════════════════════════════════════════════
//
// Page structure (from real HTML):
//   <a href="/pet/47471704-wausau-wisconsin-cat">
//     <img src="...adoptapet.com/.../1292568064" alt="Photo of Jake">
//     Jake                          ← text node or span
//     Domestic Shorthair            ← text node or span  
//     Male, 1 yr 9 mos             ← text node or span
//     Wausau, WI                   ← text node or span
//   </a>
//   ... then below the card: Color, Size, Details, Story, Learn More link
//
// Key insight: the text content has NO newlines — it's all concatenated.
// We need to find the card <a> tags that contain an <img> with "Photo of"
// in the alt text, then parse the alt text + surrounding text.

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

      // Wait for pet card images to render
      try {
        await page.waitForSelector('img[alt^="Photo of"]', { timeout: 20000 });
        console.log('    OK: pet images found');
      } catch {
        console.log('    WARN: no pet images after 20s');
        await new Promise(r => setTimeout(r, 5000));
      }

      const result = await page.evaluate(() => {
        const pets = [];
        const seen = new Set();

        // Find all images that are pet photos
        document.querySelectorAll('img[alt^="Photo of"]').forEach(img => {
          // Walk up to find the parent <a> link
          const link = img.closest('a[href*="/pet/"]');
          if (!link) return;

          const href = link.href;
          if (seen.has(href)) return;
          seen.add(href);

          // Get pet name from alt text: "Photo of Jake" → "Jake"
          const alt = img.alt || '';
          const name = alt.replace(/^Photo of\s*/i, '').trim();
          if (!name || name.length > 60) return;

          // Get photo URL and extract the image ID
          const src = img.src || '';
          let photo = null;
          if (src.includes('adoptapet.com') && !src.includes('NoPetPhoto')) {
            const idMatch = src.match(/f_auto,q_auto\/(\d+)/);
            if (idMatch) {
              photo = `https://media.adoptapet.com/image/upload/c_auto,g_auto,w_400,ar_4:3,dpr_2/f_auto,q_auto/${idMatch[1]}`;
            }
          }

          // Now extract breed, age/gender, location from the link's text
          // The full text is like: "Photo of JakeJakeDomestic ShorthairMale, 1 yr 9 mosWausau, WI"
          // Strategy: get all text nodes within the <a>, filter out img alt duplication
          const fullText = link.textContent || '';
          
          // Remove the "new badge" text if present, and the name (which appears twice from img alt + text)
          // The pattern after the name is: Breed\nGender, Age\nCity, ST
          // But there are no actual \n — we need to split smartly
          
          // Better approach: look at the text AFTER removing the pet name
          // The remaining text follows pattern: BreedGender, AgeCity, ST
          // We can use regex to extract
          
          // Find where name first appears in text (after "Photo of Name" or just "Name")
          let textAfterName = fullText;
          const nameIdx = fullText.indexOf(name);
          if (nameIdx >= 0) {
            // Find the SECOND occurrence of name (first is from img alt, second is the actual text)
            const secondIdx = fullText.indexOf(name, nameIdx + name.length);
            if (secondIdx >= 0) {
              textAfterName = fullText.substring(secondIdx + name.length);
            } else {
              textAfterName = fullText.substring(nameIdx + name.length);
            }
          }

          // Now textAfterName should be like: "Domestic ShorthairMale, 1 yr 9 mosWausau, WI"
          // or: "Schnauzer (Miniature)Male, 3 yrsWausau, WI"
          // 
          // Pattern: BREED then (Male|Female), AGE then CITY, ST
          const genderAgeMatch = textAfterName.match(/(Male|Female),\s*(.+?)(?=[A-Z][a-z]+,\s*[A-Z]{2})/);
          
          let breed = '';
          let gender = '';
          let age = '';
          
          if (genderAgeMatch) {
            gender = genderAgeMatch[1];
            age = genderAgeMatch[2].trim();
            breed = textAfterName.substring(0, genderAgeMatch.index).trim();
          } else {
            // Fallback: try to extract just breed (everything before a comma or end)
            breed = textAfterName.replace(/(?:Male|Female).*$/i, '').trim();
            const gm = textAfterName.match(/(Male|Female)/i);
            if (gm) gender = gm[1];
          }

          // Determine species from breed or URL
          const breedLower = breed.toLowerCase();
          const isCat = breedLower.includes('shorthair') || breedLower.includes('longhair') || 
                        breedLower.includes('siamese') || breedLower.includes('tabby') ||
                        breedLower.includes('calico') || breedLower.includes('persian') ||
                        breedLower.includes('bengal') || breedLower.includes('ragdoll') ||
                        href.endsWith('-cat');

          pets.push({ name, breed, age, gender, photo, url: href, species: isCat ? 'Cat' : 'Dog' });
        });

        // Get total count from "1 - 9 of 62 pets available"
        const countMatch = document.body.innerText.match(/(\d+)\s*-\s*(\d+)\s+of\s+(\d+)/);
        const totalPets = countMatch ? parseInt(countMatch[3]) : 0;
        const pageEnd = countMatch ? parseInt(countMatch[2]) : 0;

        return { pets, totalPets, pageEnd };
      });

      allPets.push(...result.pets);
      console.log(`    Found ${result.pets.length} pets (total ${allPets.length}${result.totalPets ? '/' + result.totalPets : ''})`);
      
      if (result.pets.length > 0) {
        console.log(`    Sample: ${result.pets[0].name} | ${result.pets[0].breed} | ${result.pets[0].gender}, ${result.pets[0].age} | photo: ${result.pets[0].photo ? 'YES' : 'no'}`);
      }
      
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

  // Deduplicate by URL
  const u = new Map();
  allPets.forEach(p => { if (!u.has(p.url)) u.set(p.url, p); });
  allPets = Array.from(u.values());
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
// PETFINDER SCRAPER (Clark County)
// ═══════════════════════════════════════════════════════
async function scrapePetfinder(browser, shelterKey) {
  // Use the member/org page which lists all animals
  const url = 'https://www.petfinder.com/member/us/wi/neillsville/clark-county-humane-society-wi34/';
  console.log(`\n[${shelterKey}] Petfinder: ${url}`);
  const page = await newPage(browser);

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    
    // Wait for content
    try { 
      await page.waitForSelector('a[href*="/details/"]', { timeout: 15000 }); 
      console.log('    OK: pet links found'); 
    } catch { 
      console.log('    WARN: no pet links, trying longer wait...');
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
        
        // Alt text format: "Harvey, Adoptable, Adult Male Australian Cattle Dog / Blue Heeler."
        const name = alt.split(',')[0]?.trim();
        if (!name || name.length > 60 || name.length < 2) return;

        results.push({ name, altText: alt, photo: src, url: href });
      });
      
      return results;
    });

    console.log(`  Found ${pets.length} pets`);
    
    if (pets.length > 0) {
      console.log(`    Sample alt: "${pets[0].altText}"`);
    } else {
      saveDiag(`${shelterKey}-petfinder`, await page.content());
    }
    
    await page.close();

    return pets.map(p => {
      // Parse: "Harvey, Adoptable, Adult Male Australian Cattle Dog / Blue Heeler."
      const parts = (p.altText || '').split(',').map(s => s.trim());
      const desc = parts[2] || '';
      const ageM = desc.match(/(Baby|Puppy|Kitten|Young|Adult|Senior)/i);
      const genM = desc.match(/(Male|Female)/i);
      const breed = desc.replace(/(Baby|Puppy|Kitten|Young|Adult|Senior|Male|Female)/gi, '').replace(/\.$/, '').trim();
      const isCat = p.url.includes('/cat/') || /domestic|shorthair|longhair/i.test(p.altText);
      
      return {
        name: p.name,
        species: isCat ? 'Cat' : 'Dog',
        breed: breed || 'Mixed Breed',
        age: ageM?.[1] || 'Unknown',
        gender: genM?.[1] || 'Unknown',
        bio: '',
        photo: p.photo || null,
        url: p.url
      };
    });
  } catch (err) {
    console.error(`  ERR: ${err.message}`);
    try { saveDiag(`${shelterKey}-err`, await page.content()); } catch {}
    await page.close();
    return [];
  }
}

// ═══════════════════════════════════════════════════════
// NLPAC — Bot-blocked on detail pages, so just scrape listing
// ═══════════════════════════════════════════════════════
async function scrapeNlpac(browser) {
  const url = 'https://www.nlpac.com/pets';
  console.log(`\n[nlpac] ${url}`);
  const page = await newPage(browser);

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));

    const pets = await page.evaluate(() => {
      const results = [];
      const seen = new Set();
      
      // Try to extract pet info from the listing page itself
      // Look for card-like containers with pet links
      document.querySelectorAll('a[href*="/q/pets/"]').forEach(a => {
        const href = a.href;
        if (seen.has(href) || !href) return;
        
        const parts = new URL(href).pathname.split('/').filter(Boolean);
        if (parts.length < 3) return;
        
        seen.add(href);
        
        // Try to get pet name from the link or nearby text
        const container = a.closest('div') || a.parentElement;
        const text = (container?.textContent || a.textContent || '').trim();
        
        // Get image if available
        const img = container?.querySelector('img') || a.querySelector('img');
        const photo = img?.src || null;
        
        // The pet slug from URL is the name
        const slug = parts[parts.length - 1];
        const nameFromSlug = slug.replace(/\d+$/, '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
        
        results.push({
          name: nameFromSlug,
          photo: (photo && !photo.includes('logo')) ? photo : null,
          url: href,
          rawText: text.substring(0, 200)
        });
      });
      
      return results;
    });

    console.log(`  Found ${pets.length} pet links from listing`);
    if (pets.length > 0) console.log(`    Sample: ${pets[0].name} | ${pets[0].url}`);
    if (pets.length === 0) saveDiag('nlpac-list', await page.content());
    
    await page.close();

    // Since detail pages are bot-blocked, we return basic info from the listing
    // The widget's hardcoded data will be used as primary until this improves
    return pets.map(p => ({
      name: p.name,
      species: 'Dog', // Default; we can't determine without detail page
      breed: '',
      age: '',
      gender: '',
      bio: '',
      photo: p.photo,
      url: p.url
    }));
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
  console.log('║  WP&R Pet Data Builder v3                       ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  const data = { lastUpdated: new Date().toISOString(), shelters: {} };

  // Marathon County — Adoptapet (62+ pets, paginated)
  data.shelters.marathon = await scrapeAdoptapet(
    browser,
    '77626-humane-society-of-marathon-county-wausau-wisconsin',
    'marathon'
  );

  // Clark County — Petfinder
  data.shelters.clark = await scrapePetfinder(browser, 'clark');

  // Adams County — Adoptapet (18+ pets)
  data.shelters.adams = await scrapeAdoptapet(
    browser,
    '76343-adams-county-humane-society-friendship-wisconsin',
    'adams'
  );

  // Lincoln County — removed for now (furrypets.com too dynamic)
  data.shelters.lincoln = [];

  // NLPAC — listing page only (detail pages bot-blocked)
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
    const o = pets.filter(p => !['Dog','Cat'].includes(p.species)).length;
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
