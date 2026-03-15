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
 *   - Lincoln County HS → furrypets.com (Puppeteer headless browser)
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

// ─── ADOPTAPET SCRAPER ───
// Adoptapet serves HTML with pet cards — we paginate through all pages
async function scrapeAdoptapet(browser, shelterId, shelterKey) {
  const baseUrl = `https://www.adoptapet.com/shelter/${shelterId}`;
  console.log(`\n[${shelterKey}] Scraping Adoptapet: ${baseUrl}`);
  
  let allPets = [];
  let pageNum = 1;
  const MAX_PAGES = 10;  // Safety limit
  
  while (pageNum <= MAX_PAGES) {
    const page = await browser.newPage();
    const url = pageNum === 1 
      ? `${baseUrl}/available-pets` 
      : `${baseUrl}/available-pets?page=${pageNum}`;
    
    console.log(`  Page ${pageNum}: ${url}`);
    
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(r => setTimeout(r, 3000));
      
      const result = await page.evaluate(() => {
        const pets = [];
        // Adoptapet pet cards are links containing img + text
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
        
        // Check if there's a next page
        const paginationLinks = document.querySelectorAll('nav a, .pagination a, [aria-label="Next"]');
        let hasNext = false;
        paginationLinks.forEach(a => {
          if (a.textContent.trim() === String(parseInt(document.querySelector('.pagination .active, [aria-current="page"]')?.textContent || '1') + 1)) {
            hasNext = true;
          }
        });
        // Also check for numbered page buttons
        const pageNums = [...document.querySelectorAll('button, a')].filter(el => /^\d+$/.test(el.textContent.trim()));
        const currentPage = [...document.querySelectorAll('[aria-current], .active')].find(el => /^\d+$/.test(el.textContent.trim()));
        const currentNum = parseInt(currentPage?.textContent || '1');
        if (pageNums.some(el => parseInt(el.textContent) === currentNum + 1)) hasNext = true;
        
        // Simpler check: look for page count text like "1 - 9 of 62"
        const countText = document.body.innerText.match(/\d+\s*-\s*\d+\s+of\s+(\d+)/);
        const totalPets = countText ? parseInt(countText[1]) : 0;
        
        return { pets, totalPets, hasNext };
      });
      
      allPets.push(...result.pets);
      console.log(`    Found ${result.pets.length} pets on this page (total so far: ${allPets.length}${result.totalPets ? ` of ${result.totalPets}` : ''})`);
      
      await page.close();
      
      // Stop if no pets found on this page or we have them all
      if (result.pets.length === 0) break;
      if (result.totalPets > 0 && allPets.length >= result.totalPets) break;
      
      pageNum++;
      
    } catch (err) {
      console.error(`    Error on page ${pageNum}: ${err.message}`);
      await page.close();
      break;
    }
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
  
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));
    
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
  
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));
    
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
    
    await page.close();
    console.log(`  Found ${petLinks.length} pet links, fetching details...`);
    
    // Visit each pet's detail page to get full info
    const allPets = [];
    for (const link of petLinks) {
      const detailPage = await browser.newPage();
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
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
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
  
  // Lincoln County — Puppeteer (furrypets.com)
  data.shelters.lincoln = await scrapeLincoln(browser);
  
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
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
