/**
 * Lincoln County Humane Society - Pet Scraper
 * 
 * Scrapes adoptable pets from furrypets.com using Puppeteer
 * since their WordPress site loads pet data dynamically via JavaScript.
 * 
 * Usage:
 *   node scrape-lincoln.js
 * 
 * Output:
 *   lincoln-pets.json — Array of pet objects with name, species, breed, 
 *                       age, gender, bio, photo URL, and detail page URL
 * 
 * For GitHub Actions: see .github/workflows/update-pets.yml
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const PAGES = [
  { url: 'https://furrypets.com/adopt/adopt-dogs/', species: 'Dog', ageGroup: 'Adult' },
  { url: 'https://furrypets.com/adopt/adopt-puppies/', species: 'Dog', ageGroup: 'Puppy' },
  { url: 'https://furrypets.com/adopt/adopt-cats/', species: 'Cat', ageGroup: 'Adult' },
  { url: 'https://furrypets.com/adopt/adopt-kittens/', species: 'Cat', ageGroup: 'Kitten' },
];

const OUTPUT_FILE = path.join(__dirname, 'lincoln-pets.json');

async function scrapePage(browser, { url, species, ageGroup }) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  
  console.log(`Scraping: ${url}`);
  
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });

    // Wait for dynamic content — try multiple selectors that pet plugins use
    await Promise.race([
      page.waitForSelector('.fusion-portfolio-post', { timeout: 15000 }).catch(() => null),
      page.waitForSelector('.pet-card', { timeout: 15000 }).catch(() => null),
      page.waitForSelector('[class*="animal"]', { timeout: 15000 }).catch(() => null),
      page.waitForSelector('article', { timeout: 15000 }).catch(() => null),
      page.waitForSelector('.post-card', { timeout: 15000 }).catch(() => null),
      new Promise(r => setTimeout(r, 10000)),  // Fallback: just wait 10s
    ]);

    // Extra wait for lazy-loaded images
    await new Promise(r => setTimeout(r, 3000));
    
    // Scroll to bottom to trigger lazy loading
    await page.evaluate(async () => {
      await new Promise(resolve => {
        let totalHeight = 0;
        const distance = 300;
        const timer = setInterval(() => {
          window.scrollBy(0, distance);
          totalHeight += distance;
          if (totalHeight >= document.body.scrollHeight) {
            clearInterval(timer);
            resolve();
          }
        }, 100);
      });
    });
    await new Promise(r => setTimeout(r, 2000));

    // Extract pet data using multiple strategies
    const pets = await page.evaluate((species, ageGroup) => {
      const results = [];
      const seen = new Set();

      // Helper: clean text
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

      // Strategy 1: Fusion Builder portfolio posts (Avada theme)
      document.querySelectorAll('.fusion-portfolio-post, .fusion-post-card, .post-card').forEach(el => {
        const img = el.querySelector('img:not([src*="logo"])');
        const titleEl = el.querySelector('h2, h3, h4, .entry-title, .fusion-post-card-title');
        const link = el.querySelector('a[href]');
        const descEl = el.querySelector('.fusion-post-card-excerpt, .fusion-excerpt, p');
        
        const name = clean(titleEl?.textContent);
        if (name && !seen.has(name)) {
          seen.add(name);
          results.push({
            name,
            species,
            breed: '',
            age: ageGroup,
            gender: '',
            bio: clean(descEl?.textContent)?.substring(0, 300) || '',
            photo: img?.src || img?.dataset?.src || img?.dataset?.orig || null,
            url: link?.href || ''
          });
        }
      });

      // Strategy 2: Generic article/card patterns
      if (results.length === 0) {
        document.querySelectorAll('article, .type-post, [class*="pet-"], [class*="animal-"]').forEach(el => {
          const img = el.querySelector('img:not([src*="logo"])');
          const titleEl = el.querySelector('h1, h2, h3, h4, .entry-title');
          const link = el.querySelector('a[href]');
          const descEl = el.querySelector('.entry-content, .excerpt, p');
          
          const name = clean(titleEl?.textContent);
          if (name && !seen.has(name)) {
            seen.add(name);
            results.push({
              name,
              species,
              breed: '',
              age: ageGroup,
              gender: '',
              bio: clean(descEl?.textContent)?.substring(0, 300) || '',
              photo: img?.src || null,
              url: link?.href || ''
            });
          }
        });
      }

      // Strategy 3: Image gallery with captions (common for small shelters)
      if (results.length === 0) {
        document.querySelectorAll('.gallery-item, .wp-block-image, figure, .fusion-imageframe').forEach(el => {
          const img = el.querySelector('img');
          const caption = el.querySelector('figcaption, .gallery-caption, .wp-element-caption');
          const parentLink = el.closest('a') || el.querySelector('a');
          
          if (img && img.src && !img.src.includes('logo') && !img.src.includes('data:image/gif')) {
            const name = clean(caption?.textContent || img.alt || '');
            if (name && !seen.has(name)) {
              seen.add(name);
              results.push({
                name,
                species,
                breed: '',
                age: ageGroup,
                gender: '',
                bio: '',
                photo: img.src,
                url: parentLink?.href || ''
              });
            }
          }
        });
      }

      // Strategy 4: Grab all content images and try to extract names from alt text
      if (results.length === 0) {
        document.querySelectorAll('img').forEach(img => {
          const src = img.src || img.dataset?.src || '';
          if (src && 
              !src.includes('logo') && !src.includes('data:image/gif') && 
              !src.includes('gravatar') && !src.includes('wp-includes') &&
              !src.includes('placeholder') && src.includes('wp-content/uploads')) {
            const name = clean(img.alt || '');
            if (name && name.length > 1 && name.length < 50 && !seen.has(name)) {
              seen.add(name);
              const parentLink = img.closest('a');
              results.push({
                name: name.replace(/\d+$/, '').trim(),  // Remove trailing numbers like "Zack1"
                species,
                breed: '',
                age: ageGroup,
                gender: '',
                bio: '',
                photo: src,
                url: parentLink?.href || ''
              });
            }
          }
        });
      }

      // Strategy 5: Check for ShelterLuv or RescueGroups iframes
      document.querySelectorAll('iframe').forEach(iframe => {
        if (iframe.src) {
          results.push({
            name: '__IFRAME_DETECTED__',
            species,
            breed: '',
            age: '',
            gender: '',
            bio: `Iframe source: ${iframe.src}`,
            photo: null,
            url: iframe.src
          });
        }
      });

      return results;
    }, species, ageGroup);

    console.log(`  Found ${pets.length} pets`);
    pets.forEach(p => console.log(`    - ${p.name} (${p.photo ? 'has photo' : 'no photo'})`));
    
    await page.close();
    return pets;
    
  } catch (err) {
    console.error(`  Error scraping ${url}: ${err.message}`);
    await page.close();
    return [];
  }
}

async function main() {
  console.log('=== Lincoln County Humane Society Pet Scraper ===\n');
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });
  
  let allPets = [];
  
  for (const pg of PAGES) {
    const pets = await scrapePage(browser, pg);
    allPets.push(...pets);
  }
  
  await browser.close();
  
  // Filter out iframe detection markers and duplicates
  allPets = allPets.filter(p => p.name !== '__IFRAME_DETECTED__');
  
  // Deduplicate by name
  const unique = new Map();
  allPets.forEach(p => {
    if (!unique.has(p.name)) unique.set(p.name, p);
  });
  allPets = Array.from(unique.values());
  
  // Write output
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allPets, null, 2));
  console.log(`\n✅ Saved ${allPets.length} pets to ${OUTPUT_FILE}`);
  
  // Also print summary
  const dogs = allPets.filter(p => p.species === 'Dog').length;
  const cats = allPets.filter(p => p.species === 'Cat').length;
  console.log(`   Dogs: ${dogs}, Cats: ${cats}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
