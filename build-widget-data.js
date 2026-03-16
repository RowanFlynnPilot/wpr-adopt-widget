/**
 * WP&R Adoptable Pets — Data Builder v5.2
 *
 * v5.2 fix: Adoptapet photo URLs contain "NoPetPhoto" as a Cloudinary
 * fallback path (d_PDP-NoPetPhoto_Cat.png), NOT as an indicator that
 * the pet has no photo. The real image ID is the number at the end.
 * Removed the NoPetPhoto filter — now extracts the trailing numeric ID.
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
// ADOPTAPET — click pagination + fixed photo extraction
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
        saveDiag(`${shelterKey}-initial`, await page.content());
        await page.close();
        return [];
      }
    }

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

          // ═══ PHOTO FIX (v5.2) ═══
          // The src looks like:
          // https://media.adoptapet.com/image/upload/d_PDP-NoPetPhoto_Cat.png/c_auto,g_auto,w_135,ar_27:28,dpr_2/f_auto,q_auto/1292568064
          // The "NoPetPhoto" is just the Cloudinary default fallback — the REAL image ID is the number at the very end.
          // Extract the trailing numeric ID and rebuild at higher resolution.
          const rawSrc = img.getAttribute('src') || img.src || '';
          let photo = null;
          
          if (rawSrc.includes('adoptapet.com')) {
            // Get the last numeric segment from the URL (the image ID)
            const idMatch = rawSrc.match(/\/(\d{7,})(?:\?.*)?$/);
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

        const cm = document.body.innerText.match(/(\d+)\s*-\s*(\d+)\s+of\s+(\d+)/);
        let hasNextPage = false, nextPageNum = 0;
        if (cm) {
          const perPage = parseInt(cm[2]) - parseInt(cm[1]) + 1;
          nextPageNum = Math.ceil(parseInt(cm[2]) / perPage) + 1;
          hasNextPage = [...document.querySelectorAll('button, a, [role="button"]')]
            .some(btn => btn.textContent.trim() === String(nextPageNum) && !btn.disabled);
        }

        return { pets, totalPets: cm ? parseInt(cm[3]) : 0, hasNextPage, nextPageNum };
      });

      let newCount = 0;
      for (const pet of result.pets) {
        if (!allPets.find(p => p.url === pet.url)) { allPets.push(pet); newCount++; }
      }
      if (pageNum === 1 && result.totalPets > 0) totalExpected = result.totalPets;

      const ph = result.pets.filter(p => p.photo).length;
      console.log(`    Found ${result.pets.length} on page, ${newCount} new, ${ph} photos (total ${allPets.length}${totalExpected ? '/' + totalExpected : ''})`);
      if (result.pets.length > 0) {
        const s = result.pets[0];
        console.log(`    Sample: ${s.name} | photo: ${s.photo ? s.photo.substring(0, 80) + '...' : 'no'}`);
      }

      if (newCount === 0) { console.log('    No new pets, stopping'); break; }
      if (totalExpected > 0 && allPets.length >= totalExpected) { console.log('    Got all, stopping'); break; }
      if (!result.hasNextPage) { console.log('    No next page, stopping'); break; }

      console.log(`    Clicking page ${result.nextPageNum}...`);
      const clicked = await page.evaluate((n) => {
        const btns = [...document.querySelectorAll('button, a, [role="button"]')];
        for (const b of btns) { if (b.textContent.trim() === String(n) && !b.disabled) { b.click(); return true; } }
        return false;
      }, result.nextPageNum);
      if (!clicked) { console.log('    Could not click next, stopping'); break; }

      await new Promise(r => setTimeout(r, 3000));
      try {
        await page.waitForFunction(
          (prev) => { const m = document.body.innerText.match(/(\d+)\s*-\s*\d+\s+of\s+\d+/); return m && parseInt(m[1]) !== prev; },
          { timeout: 10000 }, (pageNum - 1) * 9 + 1
        );
      } catch { await new Promise(r => setTimeout(r, 3000)); }

      pageNum++;
    }
  } catch (err) {
    console.error(`    ERR: ${err.message}`);
    try { saveDiag(`${shelterKey}-error`, await page.content()); } catch {}
  }

  await page.close();
  console.log(`  [${shelterKey}] TOTAL: ${allPets.length} pets, ${allPets.filter(p => p.photo).length} with photos`);

  return allPets.map(p => ({
    name: p.name, species: p.species, breed: p.breed || 'Unknown',
    age: p.age || 'Unknown', gender: p.gender || 'Unknown',
    bio: '', photo: p.photo, url: p.url
  }));
}

// ═══════════════════════════════════════════════════════
// PETFINDER (Clark) — unchanged
// ═══════════════════════════════════════════════════════
async function scrapePetfinder(browser, shelterKey) {
  const url = 'https://www.petfinder.com/member/us/wi/neillsville/clark-county-humane-society-wi34/';
  console.log(`\n[${shelterKey}] Petfinder: ${url}`);
  const page = await makePage(browser);
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    try { await page.waitForSelector('a[href*="/details/"]', { timeout: 15000 }); } catch { await new Promise(r => setTimeout(r, 8000)); }
    const pets = await page.evaluate(() => {
      const results = [], seen = new Set();
      document.querySelectorAll('a[href*="/details/"]').forEach(link => {
        const href = link.href; if (seen.has(href)) return; seen.add(href);
        const img = link.querySelector('img'); if (!img) return;
        const alt = img.alt || '', src = img.src || '';
        const name = alt.split(',')[0]?.trim();
        if (!name || name.length > 60 || name.length < 2) return;
        results.push({ name, altText: alt, photo: src, url: href });
      });
      return results;
    });
    console.log(`  Found ${pets.length} pets`);
    await page.close();
    return pets.map(p => {
      const parts = (p.altText || '').split(',').map(s => s.trim()); const desc = parts[2] || '';
      const ageM = desc.match(/(Baby|Puppy|Kitten|Young|Adult|Senior)/i);
      const genM = desc.match(/(Male|Female)/i);
      const breed = desc.replace(/(Baby|Puppy|Kitten|Young|Adult|Senior|Male|Female)/gi, '').replace(/\.$/, '').trim();
      const isCat = p.url.includes('/cat/') || /domestic|shorthair|longhair/i.test(p.altText);
      return { name: p.name, species: isCat ? 'Cat' : 'Dog', breed: breed || 'Mixed Breed', age: ageM?.[1] || 'Unknown', gender: genM?.[1] || 'Unknown', bio: '', photo: p.photo || null, url: p.url };
    });
  } catch (err) {
    console.error(`  ERR: ${err.message}`);
    await page.close(); return [];
  }
}

// ═══════════════════════════════════════════════════════
// LINCOLN COUNTY — WordPress REST API (furrypets.com)
// Their site uses Avada theme with portfolio posts for pets.
// The WP REST API exposes these as JSON — no browser needed.
// ═══════════════════════════════════════════════════════
async function scrapeLincoln() {
  console.log('\n[lincoln] Trying WordPress REST API...');

  // Avada stores portfolio items as 'avada_portfolio' post type
  // Also try 'portfolio' and regular 'posts' as fallbacks
  const postTypes = ['avada_portfolio', 'portfolio', 'posts'];
  
  // First, discover available post types
  try {
    const typesRes = await fetch('https://furrypets.com/wp-json/wp/v2/types', { headers: { 'User-Agent': UA } });
    if (typesRes.ok) {
      const types = await typesRes.json();
      console.log(`  Available post types: ${Object.keys(types).join(', ')}`);
    }
  } catch (e) {
    console.log(`  Could not fetch post types: ${e.message}`);
  }

  // Try each post type to find pet listings
  for (const postType of postTypes) {
    const apiUrl = `https://furrypets.com/wp-json/wp/v2/${postType}?per_page=100&_fields=id,title,link,content,excerpt,featured_media,categories`;
    console.log(`  Trying: ${apiUrl}`);

    try {
      const res = await fetch(apiUrl, { headers: { 'User-Agent': UA } });
      
      if (!res.ok) {
        console.log(`    HTTP ${res.status} — skipping`);
        continue;
      }

      const posts = await res.json();
      
      if (!Array.isArray(posts) || posts.length === 0) {
        console.log(`    No posts found for type '${postType}'`);
        continue;
      }

      console.log(`    Found ${posts.length} posts of type '${postType}'`);

      // Filter and parse pet posts
      const allPets = [];

      for (const post of posts) {
        const title = post.title?.rendered || '';
        const name = title.replace(/<[^>]+>/g, '').trim();
        const link = post.link || '';
        const content = (post.content?.rendered || '').replace(/<[^>]+>/g, ' ').trim();
        const excerpt = (post.excerpt?.rendered || '').replace(/<[^>]+>/g, ' ').trim();
        const combined = (content + ' ' + excerpt).toLowerCase();

        // Skip non-pet posts (news, events, etc.)
        if (!name || name.length > 80) continue;
        // Skip if it looks like a news/info post
        if (combined.includes('newsletter') || combined.includes('thank you') || combined.includes('membership')) continue;

        // Try to get featured image
        let photo = null;
        if (post.featured_media && post.featured_media > 0) {
          try {
            const mediaRes = await fetch(`https://furrypets.com/wp-json/wp/v2/media/${post.featured_media}?_fields=source_url`, { headers: { 'User-Agent': UA } });
            if (mediaRes.ok) {
              const media = await mediaRes.json();
              photo = media.source_url || null;
            }
          } catch {}
        }

        // Also try to extract image from content HTML
        if (!photo) {
          const imgMatch = (post.content?.rendered || '').match(/<img[^>]+src="([^"]+)"/i);
          if (imgMatch && !imgMatch[1].includes('logo')) photo = imgMatch[1];
        }

        // Determine species from link URL or content
        let species = 'Dog';
        if (link.includes('cat') || link.includes('kitten') || combined.includes('domestic shorthair') || combined.includes('domestic longhair')) {
          species = 'Cat';
        }

        // Try to extract breed/gender/age from content
        let breed = '', gender = '', age = 'Adult';
        if (combined.includes('female')) gender = 'Female';
        else if (combined.includes('male')) gender = 'Male';
        if (combined.includes('kitten') || combined.includes('puppy')) age = 'Young';
        if (combined.includes('senior')) age = 'Senior';

        console.log(`      ${name} | ${species} | ${gender} | photo: ${photo ? 'YES' : 'no'}`);

        allPets.push({
          name, species, breed, age, gender,
          bio: excerpt.substring(0, 300),
          photo,
          url: link
        });
      }

      if (allPets.length > 0) {
        console.log(`  [lincoln] TOTAL: ${allPets.length} pets, ${allPets.filter(p => p.photo).length} with photos`);
        return allPets;
      }

    } catch (err) {
      console.log(`    Error: ${err.message}`);
    }
  }

  // If REST API didn't work, log it
  console.log('  [lincoln] REST API returned no pets — will use fallback data in widget');
  return [];
}

// ═══════════════════════════════════════════════════════
// NLPAC — plain HTTP fetch (bot protection only blocks Puppeteer, not fetch)
// Step 1: fetch listing page to get pet links
// Step 2: fetch each detail page for full info + photos
// ═══════════════════════════════════════════════════════
async function scrapeNlpac() {
  const listUrl = 'https://www.nlpac.com/pets';
  console.log(`\n[nlpac] ${listUrl}`);

  try {
    // Step 1: Get listing page and extract pet links
    const listRes = await fetch(listUrl, { headers: { 'User-Agent': UA } });
    const listHtml = await listRes.text();

    // Extract all /q/pets/name links
    const linkRegex = /href="(https?:\/\/www\.nlpac\.com\/q\/pets\/[^"]+)"/g;
    const links = new Set();
    let match;
    while ((match = linkRegex.exec(listHtml)) !== null) {
      links.add(match[1]);
    }

    console.log(`  Found ${links.size} pet links`);
    if (links.size === 0) {
      saveDiag('nlpac-list', listHtml);
      return [];
    }

    // Step 2: Fetch each detail page
    const allPets = [];
    for (const petUrl of links) {
      try {
        console.log(`    Fetching: ${petUrl}`);
        const detailRes = await fetch(petUrl, { headers: { 'User-Agent': UA } });
        const html = await detailRes.text();

        // Parse name from <h1>Meet Ninja</h1>
        const nameMatch = html.match(/<h1[^>]*>Meet\s+(.+?)<\/h1>/i);
        const name = nameMatch ? nameMatch[1].trim() : '';
        if (!name) { console.log('      SKIP: no name found'); continue; }

        // Parse photo from <img> with custompages or bizcategories in src
        const photoMatch = html.match(/<img[^>]+src="(https:\/\/www\.wausaubusinessdirectory\.com\/images[^"]*custompages[^"]+)"/i);
        const photo = photoMatch ? photoMatch[1] : null;

        // Parse structured info from <li><strong>Key:</strong> Value</li>
        const info = {};
        const liRegex = /<li[^>]*>\s*<strong>([^<]+):<\/strong>\s*([^<]+)/gi;
        let liMatch;
        while ((liMatch = liRegex.exec(html)) !== null) {
          info[liMatch[1].trim()] = liMatch[2].trim();
        }

        // Also try without <strong> tags: "Animal Type: Cat"
        const liRegex2 = /<li[^>]*>\s*\*?\*?([^:*]+):\*?\*?\s*([^<]+)/gi;
        while ((liMatch = liRegex2.exec(html)) !== null) {
          const key = liMatch[1].replace(/\*/g, '').trim();
          if (!info[key]) info[key] = liMatch[2].trim();
        }

        // Parse description
        const descMatch = html.match(/Description:?\s*<\/[^>]+>\s*<[^>]+>(.+?)<\//is);
        let bio = '';
        if (descMatch) {
          bio = descMatch[1].replace(/<[^>]+>/g, '').trim();
        }
        // Fallback: find the paragraph after "Description"
        if (!bio) {
          const descMatch2 = html.match(/Description:?\s*(?:<[^>]+>\s*)*(.+?)(?:<\/p>|<\/div>|<br)/is);
          if (descMatch2) bio = descMatch2[1].replace(/<[^>]+>/g, '').trim();
        }

        const animalType = (info['Animal Type'] || '').toLowerCase();
        const breed = info['Breed'] || '';
        const age = info['Age'] || 'Adult';

        // Species
        let species = 'Dog';
        if (animalType.includes('cat')) species = 'Cat';
        else if (animalType.includes('guinea') || breed.toLowerCase().includes('guinea')) species = 'Other';

        // Gender from bio
        let gender = '';
        const bioLower = bio.toLowerCase();
        if (bioLower.includes('female') || bioLower.includes(' her ') || bioLower.includes(' she ')) gender = 'Female';
        else if (bioLower.includes(' male') || bioLower.includes(' his ') || bioLower.includes(' he ')) gender = 'Male';

        console.log(`      ✅ ${name} | ${breed} | ${species} | ${gender} | ${age} | photo: ${photo ? 'YES' : 'no'}`);

        allPets.push({
          name, species, breed, age, gender,
          bio: bio.substring(0, 300),
          photo,
          url: petUrl
        });

        // Small delay to be polite
        await new Promise(r => setTimeout(r, 500));

      } catch (err) {
        console.error(`      ERR on ${petUrl}: ${err.message}`);
      }
    }

    console.log(`  [nlpac] TOTAL: ${allPets.length} pets, ${allPets.filter(p => p.photo).length} with photos`);
    return allPets;

  } catch (err) {
    console.error(`  ERR: ${err.message}`);
    return [];
  }
}

// ═══════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════
async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  WP&R Pet Data Builder v5.3                     ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-blink-features=AutomationControlled']
  });

  const data = { lastUpdated: new Date().toISOString(), shelters: {} };
  data.shelters.marathon = await scrapeAdoptapet(browser, '77626-humane-society-of-marathon-county-wausau-wisconsin', 'marathon');
  data.shelters.clark = await scrapePetfinder(browser, 'clark');
  data.shelters.adams = await scrapeAdoptapet(browser, '76343-adams-county-humane-society-friendship-wisconsin', 'adams');
  data.shelters.lincoln = []; // furrypets.com too dynamic, using widget fallback
  data.shelters.nlpac = await scrapeNlpac();
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
