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

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
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

/** Close a page without ever throwing — the browser may already be gone.
 *  (An unprotected page.close() after a Chrome crash killed the whole
 *  2026-07-26 build; nothing got published that run.) */
async function safeClose(page) {
  try { if (page && !page.isClosed()) await page.close(); } catch (_) {}
}

/**
 * Classify species from breed and listing URL ONLY — never from the pet's
 * name or free-text details. A Pit Bull named "Finch" or a dog named "Bunny"
 * must not be classified as a bird/small-animal. Adoptapet URL slugs are
 * {id}-{city}-{state}-{breed}, so the URL carries breed info but not names.
 */
function classifySpecies(breed, url) {
  const breedLower = (breed || '').toLowerCase();
  const urlRaw = (url || '').toLowerCase();
  if (
    /short\s*hair|long\s*hair|medium\s*hair|siamese|tabby|calico|persian|bengal|ragdoll|tortoiseshell|tortie|maine coon|\bdsh\b|\bdlh\b|\bdmh\b/.test(breedLower) ||
    /\bcat\b/.test(breedLower) ||
    /-cat$|-wisconsin-cat/.test(urlRaw)
  ) return 'Cat';
  // Rat Terrier is a dog breed — strip before small-animal keyword matching
  const text = `${breedLower} ${urlRaw.replace(/-/g, ' ')}`.replace(/\brat terriers?\b/g, '');
  if (
    /\b(rats?|mouse|mice|hamsters?|guinea pigs?|cavy|rabbits?|bunny|bunnies|ferrets?|gerbils?|hedgehogs?|chinchillas?|lizards?|reptiles?|turtles?|tortoises?|snakes?|geckos?|parakeets?|cockatiels?|parrots?|birds?|finch|finches|canary|canaries|rodents?)\b/.test(text) ||
    /small animal/.test(text)
  ) return 'Other';
  return 'Dog';
}

// ─── LINCOLN COUNTY: LINK-OUT CARDS ───
// Lincoln County HS went application-first in mid-2026: their individual pets
// are no longer listed anywhere scrapeable (Adoptapet emptied to 0 ~July 2026;
// furrypets.com hard-403s automated access; they're not on Petfinder). Rather
// than show a stale single pet or an empty shelter, present browse/apply
// link-out cards so adopters can still reach them (humans aren't blocked — only
// automation is). These are marked `placeholder` so they're excluded from
// firstSeen tracking, "New" badges, and the featured-pet snapshot.
const LINCOLN_LINKOUTS = [
  {
    name: 'Browse Adoptable Dogs', species: 'Dog',
    breed: 'Apply to adopt at furrypets.com', age: '', gender: '',
    bio: "Lincoln County Humane Society places dogs by application. Click to see their available dogs and start an adoption application on the shelter's website.",
    photo: null, url: 'https://furrypets.com/adopt/adopt-dogs/', placeholder: true,
  },
  {
    name: 'Browse Adoptable Cats', species: 'Cat',
    breed: 'Apply to adopt at furrypets.com', age: '', gender: '',
    bio: "Lincoln County Humane Society places cats and kittens by application. Click to see who's available and start an adoption application on the shelter's website.",
    photo: null, url: 'https://furrypets.com/adopt/adopt-cats/', placeholder: true,
  },
];

// Keep any real photo-bearing Adoptapet listing that appears, then always
// append the link-out cards so Lincoln is never empty/stale.
function ensureLincolnLinkouts(pets) {
  const real = (pets || []).filter(p => p && p.photo && !p.placeholder);
  return [...real, ...LINCOLN_LINKOUTS];
}

// ─── ADOPTAPET SCRAPER ───
// Adoptapet uses client-side pagination. The shelter page shows 12 pets/page but
// /pet-search shows 42/page and is more reliable. Try search URL first, fall back to shelter page.
const SHELTER_POSTAL = {
  '77626': '54401',  // Marathon
  '76343': '53934',  // Adams
  '66070': '54452',  // Lincoln
  '151032': '54401', // Fetch (Wausau)
  '20247': '54494',  // South Wood County HS (Wisconsin Rapids)
  '96724': '54449',  // Marshfield Area Pet Shelter
  '87863': '54467',  // Humane Society of Portage County (Plover/Stevens Point)
  '81472': '54451',  // Taylor County WI Humane Society (Medford)
};

async function scrapeAdoptapet(browser, shelterId, shelterKey) {
  const numericId = shelterId.match(/^(\d+)/)?.[1] || '';
  const postalCode = SHELTER_POSTAL[numericId] || '';
  // Prefer /pet-search URL (42 per page) over shelter page (12 per page)
  const searchUrl = postalCode ? `https://www.adoptapet.com/pet-search?radius=50&postalCode=${postalCode}&awos[0]=${numericId}&filterMode=all` : '';
  const baseUrl = `https://www.adoptapet.com/shelter/${shelterId}`;
  const url = searchUrl || `${baseUrl}/available-pets`;
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

    // Scroll to trigger lazy-loaded cards (some shelters load more as you scroll)
    await page.evaluate(async () => {
      const step = 400;
      for (let y = 0; y < document.body.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise(r => setTimeout(r, 150));
      }
      window.scrollTo(0, 0);
    });
    await new Promise(r => setTimeout(r, 2000));

    while (pageNum <= MAX_PAGES) {
      console.log(`  Page ${pageNum}...`);

      const result = await page.evaluate(() => {
        const pets = [];
        const seen = new Set();
        document.querySelectorAll('a[href*="/pet/"]').forEach(card => {
          // Skip badge/overlay images (e.g. "New!" badge) — find the actual pet photo
          const img = card.querySelector('img[alt^="Photo of"]') || 
                       card.querySelector('img:not([alt="new badge"]):not([src*="badge"])') ||
                       card.querySelector('img');
          const href = (card.href || '').split('?')[0];

          if (!href || !href.includes('/pet/') || href.includes('blog')) return;
          if (seen.has(href)) return;
          seen.add(href);

          const fullText = card.textContent.trim();
          const textLines = fullText.split(/\n/).map(s => s.trim()).filter(Boolean);
          // Prefer image alt "Photo of Ada" for name; site often has no newlines so textLines[0] can be one long blob
          let name = '';
          if (img && img.alt && /^Photo of\s+/i.test(img.alt)) {
            name = img.alt.replace(/^Photo of\s+/i, '').trim();
          }
          if (!name && textLines[0]) {
            name = textLines[0];
            // If name looks like concatenated blob (e.g. "AdaDomestic ShorthairFemale, 11 mos"), take only the pet name part
            if (name.length > 35 || /Domestic|Shorthair|Longhair|Female|Male|Friendship|,?\s*\d+\s*(?:yr|mo|wk)/i.test(name)) {
              const cleaned = name.replace(/(Domestic\s*)?(Shorthair|Longhair|Mediumhair)?\s*(Male|Female).*$/i, '').trim();
              // Truncate at a word boundary so we don't ship names like "Blossom * Hydrolyzed Protein D"
              let cut = name.substring(0, 30);
              if (name.length > 30 && cut.includes(' ')) cut = cut.substring(0, cut.lastIndexOf(' '));
              name = (cleaned || cut).trim();
            }
          }
          let breed = textLines[1] || '';
          // Filter out nav menu text pollution (e.g. "Breed 101" → textLines picks up "101")
          if (/^\d+$/.test(breed.trim()) || breed.trim().length < 3) breed = '';
          const details = textLines[2] || fullText; // use fullText when no clear lines so we can regex gender/age later
          if (!breed && fullText) {
            const afterName = name ? fullText.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '').trim() : fullText;
            const m = afterName.match(/^(.+?)\s+(?:Male|Female)\b/i);
            if (m && m[1] && !/\d+\s*(?:yr|mo|wk)/i.test(m[1].trim())) breed = m[1].trim();
          }

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
      // Try clicking next page — use aria-label first (most reliable for React), then text content
      const clicked = await page.evaluate((n) => {
        // Strategy 1: aria-label="Page N" (Adoptapet's React pagination)
        const byAria = document.querySelector(`[aria-label="Page ${n}"]`);
        if (byAria) { byAria.click(); return 'aria'; }
        // Strategy 2: button/link with text content matching page number
        const candidates = [...document.querySelectorAll('button, a, [role="button"]')];
        const byNum = candidates.find(el => el.textContent.trim() === String(n) && !el.disabled);
        if (byNum) { byNum.click(); return 'num'; }
        // Strategy 3: "Next" button
        const byNext = candidates.find(el =>
          /^next$/i.test(el.textContent.trim()) || (el.getAttribute('aria-label') || '').toLowerCase().includes('next')
        );
        if (byNext && !byNext.disabled) { byNext.click(); return 'next'; }
        return false;
      }, result.nextPageNum);

      if (!clicked) {
        console.log('    Could not click next page, stopping');
        break;
      }
      console.log(`    Clicked page ${result.nextPageNum} via ${clicked}`);

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
        // Page didn't update — try scrolling to trigger re-render
        await page.evaluate(() => window.scrollTo(0, 0));
        await new Promise(r => setTimeout(r, 3000));
      }

      pageNum++;
    }
  } catch (err) {
    console.error(`  Error: ${err.message}`);
    try { saveDiag(`${shelterKey}-adoptapet-error`, await page.content()); } catch (_) {}
  } finally {
    await safeClose(page);
  }

  // Fallback: if card-based scraping found very few results, extract pet URLs from
  // the page's raw HTML/script data. Adoptapet is a Next.js React app — after JS
  // hydration, pet cards may be re-rendered with fewer visible than the server-
  // rendered HTML contained. This fallback catches pets embedded in RSC payloads.
  // Trigger fallback if we got less than half the expected total (pagination likely failed)
  const needsFallback = totalExpected > 0 ? allPets.length < totalExpected * 0.5 : allPets.length <= 3;
  if (needsFallback) {
    console.log(`  [${shelterKey}] Only ${allPets.length} pets from cards (expected ${totalExpected || '?'}) — trying HTML fallback...`);
    let fallbackPage = null;
    // Use shelter page for fallback (different HTML structure, may have more embedded URLs)
    const fallbackUrl = `${baseUrl}/available-pets`;
    try {
      fallbackPage = await makePage(browser);
      await fallbackPage.goto(fallbackUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(r => setTimeout(r, 3000));
      const rawHtml = await fallbackPage.content();
      saveDiag(`${shelterKey}-fallback`, rawHtml);

      // Extract pet URLs from anywhere in page source (rendered cards, script data, RSC payloads)
      const urlMatches = rawHtml.match(/\/pet\/(\d+)-([a-z-]+)/g) || [];
      const seenUrls = new Set(allPets.map(p => p.url));
      const newUrls = [...new Set(urlMatches)]
        .map(path => `https://www.adoptapet.com${path}`)
        .filter(u => !seenUrls.has(u) && !u.includes('blog'));

      if (newUrls.length > 0) {
        console.log(`    Found ${newUrls.length} additional pet URLs in page source`);
        for (const petUrl of newUrls) {
          // Extract name from the page if possible (look for "Photo of X" near this URL)
          const petId = petUrl.match(/\/pet\/(\d+)/)?.[1] || '';
          const nameFromAlt = rawHtml.match(new RegExp(`${petId}[\\s\\S]{0,500}?Photo of ([^"<]+)`, 'i'));
          const nameFromTitle = rawHtml.match(new RegExp(`Photo of ([^"<]+)[\\s\\S]{0,500}?${petId}`, 'i'));
          let name = (nameFromAlt?.[1] || nameFromTitle?.[1] || '').trim();

          // Fallback: extract name from URL slug (e.g., /pet/12345-wausau-wisconsin-bichon-frise-mix)
          if (!name || name.length >= 50) {
            const slugMatch = petUrl.match(/\/pet\/\d+-(?:[a-z]+-)+?([a-z]+(?:-[a-z]+)*)-mix$/i) ||
                              petUrl.match(/\/pet\/\d+-[a-z]+-[a-z]+-(.+)/i);
            // Try to get the pet name from the slug before the city name
            const fullSlug = petUrl.match(/\/pet\/\d+-(.+)/)?.[1] || '';
            const parts = fullSlug.split('-');
            // URL format: {city}-{state}-{breed-or-name}... First word before city is often the name
            // But many URLs are like: wausau-wisconsin-cat or wausau-wisconsin-bichon-frise-mix
            // Best effort: we'll add it with empty name and let the bio-fetcher get the real name from the detail page
            name = '';
          }

          // Add pet even without name — bio fetcher will get name from detail page
          allPets.push({
            name: name || '',
            breed: '',
            details: '',
            photo: null,
            url: petUrl
          });
          console.log(`    + ${name || '(unnamed)'} (from HTML fallback)`);
        }
      }
    } catch (err) {
      console.log(`    Fallback failed: ${err.message}`);
    }
    await safeClose(fallbackPage);
  }

  console.log(`  [${shelterKey}] TOTAL: ${allPets.length} pets scraped`);
  
  // Deduplicate by URL
  const unique = new Map();
  allPets.forEach(p => { if (!unique.has(p.url)) unique.set(p.url, p); });
  allPets = Array.from(unique.values());

  // Pure-numeric "names" are scrape artifacts (animal IDs like "61157621") —
  // clear them so the bio fetcher recovers the real name from the detail page.
  allPets.forEach(p => { if (/^\d+$/.test((p.name || '').trim())) p.name = ''; });

  // Fetch bio from each pet's detail page (Adoptapet lists only name/breed/age
  // on listing). ONE page is reused for all pets — creating hundreds of pages
  // per run destabilizes Chrome on CI runners and crashed the 2026-07-26 build.
  if (allPets.length > 0) {
    console.log(`  Fetching bios for ${allPets.length} pets...`);
    let bioPage = null;
    for (let i = 0; i < allPets.length; i++) {
      const pet = allPets[i];
      try {
        if (!bioPage || bioPage.isClosed()) bioPage = await makePage(browser);
        await bioPage.goto(pet.url, { waitUntil: 'networkidle2', timeout: 15000 });
        await new Promise(r => setTimeout(r, 3000)); // longer wait for React/Next.js hydration

        // Click "Read more" to expand truncated bios
        await bioPage.evaluate(() => {
          const candidates = [...document.querySelectorAll('button, a, span, [role="button"]')];
          const readMore = candidates.find(el => /^\s*Read\s*more\s*$/i.test(el.textContent));
          if (readMore) readMore.click();
        });
        await new Promise(r => setTimeout(r, 1000)); // wait for expansion

        const petHasName = !!pet.name;
        const { bio: pageBio, breed: pageBreed, pageName, pagePhoto, pageAge, pageGender } = await bioPage.evaluate((pet_has_name) => {
          const skip = /Cared for by|Ask About Me|Humane Society of|^Adopt\b|^Contact\b|^Share\b|^Print\b|This pet has no story|no story|Contact this organization for more information|^\s*Read\s*more\s*$|^\s*Read\s*less\s*$/i;

          // Strategy 1: Look for "Here's what the humans have to say" heading and grab text after it
          let out = '';
          const allEls = [...document.querySelectorAll('h2, h3, h4, [class*="heading"], [class*="title"]')];
          const storyHeading = allEls.find(el => /humans have to say|my story|about me/i.test(el.textContent));
          if (storyHeading) {
            let next = storyHeading.nextElementSibling;
            while (next && !/^H[1-4]$/i.test(next.tagName)) {
              const t = next.textContent.trim().replace(/\s+/g, ' ');
              if (t.length > 20 && !skip.test(t) && !t.includes('adoptapet.com')) {
                out += (out ? ' ' : '') + t;
              }
              if (out.length >= 1500) break;
              next = next.nextElementSibling;
            }
          }

          // Strategy 2: Fallback to scanning paragraphs and text-heavy divs
          if (!out) {
            const paras = [...document.querySelectorAll('main p, article p, [class*="content"] p, [class*="description"] p, [class*="story"] p, [class*="bio"] p, main div > p, section p')];
            for (const para of paras) {
              const t = para.textContent.trim().replace(/\s+/g, ' ');
              if (t.length < 50) continue;
              if (skip.test(t) || t.includes('adoptapet.com')) continue;
              out += (out ? ' ' : '') + t;
              if (out.length >= 1500) break;
            }
          }
          // Strip common intro prefixes and artifacts
          let bio = out ? out.replace(/^Here'?s what the humans have to say about me:?\s*/i, '').trim() : '';
          // Remove "Read more" / "Read less" text that may have been captured
          bio = bio.replace(/\s*Read\s*more\s*$/i, '').replace(/\s*Read\s*less\s*$/i, '').trim();
          // Strip trailing structured info (rescues append apply links, stats, boilerplate)
          bio = bio.replace(/\s*Apply here:.*$/is, '').trim();
          bio = bio.replace(/\s*(?:Name|DOB|Weight|Breed|Sex|Altered|Adoption(?:\s*Fee)?|Good with\s*(?:Cats|Dogs|Kids)|Special Requirements|Fetch Foster)\s*:.*$/is, '').trim();
          bio = bio.replace(/\s*##\d+##.*$/i, '').trim();
          bio = bio.replace(/\s*\*?Positive reinforcement\s+ob.*$/is, '').trim();
          bio = bio.replace(/\s*Fetch Foster and Rescue Inc is a 501.*$/i, '').trim();
          bio = bio.replace(/\s*Anyone who provides proof of completed.*$/is, '').trim();
          // Fix backtick apostrophes (Adoptapet uses ` instead of ')
          bio = bio.replace(/`/g, "'");
          bio = bio ? bio.substring(0, 1500) : '';

          // === BREED EXTRACTION (multiple strategies, ordered by reliability) ===
          let breed = '';

          // Strategy 1: dt/dd pairs (Adoptapet's "My basic info" section)
          // Structure: <dt>Breed</dt><dd><span><a>Domestic Shorthair</a></span></dd>
          const dtEls = document.querySelectorAll('dt');
          for (const dt of dtEls) {
            if (/^\s*Breed\s*$/i.test(dt.textContent)) {
              const dd = dt.nextElementSibling;
              if (dd && dd.tagName === 'DD') {
                breed = dd.textContent.trim().replace(/\s+/g, ' ').substring(0, 80);
                break;
              }
            }
          }

          // Strategy 2: page title contains breed ("Wausau, WI - Domestic Shorthair. Meet X...")
          if (!breed) {
            const titleMatch = document.title.match(/^.+?-\s*(.+?)\.\s*Meet\s/i);
            if (titleMatch && titleMatch[1]) breed = titleMatch[1].trim();
          }

          // Strategy 3: og:description meta ("Pictures of X a Domestic Shorthair for adoption...")
          if (!breed) {
            const ogDesc = document.querySelector('meta[property="og:description"]')?.content || '';
            const ogMatch = ogDesc.match(/\ba\s+(.+?)\s+for\s+adoption/i);
            if (ogMatch && ogMatch[1]) breed = ogMatch[1].trim();
          }

          // Filter out nav text pollution (e.g. "Breed 101" → "101")
          if (/^\d+$/.test(breed) || breed.length < 3) breed = '';

          // Extract age and gender from dt/dd pairs (Adoptapet "My basic info" section)
          let pageAge = '', pageGender = '';
          for (const dt of dtEls) {
            const label = dt.textContent.trim().toLowerCase();
            const dd = dt.nextElementSibling;
            if (!dd || dd.tagName !== 'DD') continue;
            const val = dd.textContent.trim().replace(/\s+/g, ' ');
            if (label === 'age' && val) pageAge = val;
            if (label === 'sex' && val) pageGender = val.split(/\s/)[0]; // "Male" or "Female"
          }
          // Also try og:description: "Pictures of X a Domestic Shorthair for adoption in Wausau, WI. ... 1 year old Male."
          if (!pageAge) {
            const ogDesc = document.querySelector('meta[property="og:description"]')?.content || '';
            const ageMatch = ogDesc.match(/(\d+\s*(?:year|yr|month|mo|week|wk)s?\s*(?:old)?)/i);
            if (ageMatch) pageAge = ageMatch[1].replace(/\s*old/i,'').trim();
          }

          // Extract name from page if we don't have one
          let pageName = '';
          if (!pet_has_name) {
            // Try h1 or page title: "My name is Mars!" or "Meet Franklin"
            const h1 = document.querySelector('h1');
            if (h1) {
              pageName = h1.textContent
                .replace(/^My name is\s+/i, '')
                .replace(/^Meet\s+/i, '')
                .replace(/!$/, '')
                .trim();
            }
            if (!pageName || /oops|something.*gone wrong|error|not found/i.test(pageName)) {
              pageName = '';
              const titleMatch = document.title.match(/Meet\s+(.+?)(?:\s*[-–|]|\s*$)/i);
              if (titleMatch) pageName = titleMatch[1].trim();
            }
            if (!pageName || /oops|something.*gone wrong|error|not found/i.test(pageName)) {
              pageName = '';
              const ogTitle = document.querySelector('meta[property="og:title"]')?.content || '';
              const ogMatch = ogTitle.match(/Meet\s+(.+?)(?:\s*[-–|]|\s*$)/i);
              if (ogMatch) pageName = ogMatch[1].trim();
            }
            // Reject error page names
            if (/oops|something.*gone wrong|error|not found|page.*not/i.test(pageName)) pageName = '';
          }

          // Extract photo from detail page
          let pagePhoto = null;
          // Try multiple selectors — Adoptapet uses different markup across pages
          const imgCandidates = [
            document.querySelector('img.pet-image'),
            document.querySelector('img[alt^="Photo of"]'),
            document.querySelector('[class*="pet"] img[src*="adoptapet"]'),
            document.querySelector('img[src*="media.adoptapet.com"][src*="upload"]'),
            document.querySelector('main img[src*="adoptapet"]'),
          ].filter(Boolean);
          for (const img of imgCandidates) {
            if (img.src && !/new-badge|placeholder|svg/i.test(img.src) && /\d{7,}/.test(img.src)) {
              pagePhoto = img.src;
              break;
            }
          }

          return { bio, breed, pageName, pagePhoto, pageAge, pageGender };
        }, petHasName);
        const generic = /Cared for by|Ask About Me|Humane Society of|This pet has no story|no story.*Contact this organization/i;
        pet.bio = (pageBio && !generic.test(pageBio) && pageBio.length >= 50) ? pageBio : '';
        if (pageBreed) pet.breedFromPage = pageBreed;
        // Fill in missing name/photo from detail page (for HTML fallback pets)
        if (!pet.name && pageName) pet.name = pageName;
        if (!pet.photo && pagePhoto) pet.photo = pagePhoto;
        // Fill in age/gender from detail page if missing from card scrape
        if (pageAge) pet.ageFromPage = pageAge;
        if (pageGender) pet.genderFromPage = pageGender;
      } catch (err) {
        pet.bio = '';
        // The page (or whole browser) may have died — drop it so the next
        // iteration recreates it. If Chrome itself is gone, stop fetching
        // bios and keep the listing data we already have.
        await safeClose(bioPage);
        bioPage = null;
        if (!browser.connected) {
          console.log(`    Browser connection lost — keeping listing data for remaining ${allPets.length - i - 1} pets`);
          break;
        }
      }
      if ((i + 1) % 10 === 0) console.log(`    Bios: ${i + 1}/${allPets.length}`);
      await new Promise(r => setTimeout(r, 600));
    }
    await safeClose(bioPage);
  }

  // Filter out pets with no name, error page names, or numeric ID names
  allPets = allPets.filter(p => {
    if (!p.name || p.name.length === 0) return false;
    if (/^\d+$/.test(p.name.trim())) return false;
    if (/oops|something.*gone wrong|error|not found|page.*not/i.test(p.name)) return false;
    return true;
  });

  // Transform to standard format
  return allPets.map(p => {
    const raw = (p.details || '').trim();
    // Gender: try word boundary first, then comma/space boundaries, then any occurrence
    const genderMatch =
      raw.match(/\b(Male|Female)\b/i) ||
      raw.match(/(?:^|[\s,])(Male|Female)(?=[\s,]|$)/i) ||
      raw.match(/(Male|Female)/i);
    const gender = genderMatch ? genderMatch[1].trim() : '';

    // Breed: from card line if present, else parse from details (text before "Male"/"Female" that isn't age)
    let breed = (p.breed || '').trim();
    if (!breed && raw) {
      const withoutName = p.name
        ? raw.replace(new RegExp(p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '').trim()
        : raw;
      const beforeGender = withoutName.match(/^(.+?)\s+(?:Male|Female)\b/i);
      if (beforeGender) {
        const cand = beforeGender[1].trim();
        if (!/\d+\s*(?:yr|yrs?|mo|mos?|wk|wks?)/i.test(cand)) breed = cand;
      }
      if (!breed && raw) {
        const knownBreeds =
          /Domestic\s+Shorthair|Domestic\s+Longhair|Domestic\s+Medium\s*Hair|Siamese|Tabby|Calico|Persian|Bengal|Ragdoll|Labrador|Shepherd|Terrier|Hound|Retriever|Pit\s*Bull|Beagle|Chihuahua|Mix|Mix\s*Breed/gi;
        const m = raw.match(knownBreeds);
        if (m) breed = m[0].replace(/\s+/g, ' ').trim();
      }
    }
    if (p.breedFromPage) breed = (p.breedFromPage || breed).trim();

    // Final guard: reject garbage breed values (pure numbers like "101" from Adoptapet nav)
    if (/^\d+$/.test(breed) || breed.length < 3) breed = '';

    // Age: e.g. "1 yr 9 mos" — capture number+unit(s), stop before location (Wausau, Merrill, WI etc.)
    let ageMatch = raw.match(
      /(\d+\s*(?:yr|yrs?|mo|mos?|wk|wks?)(?:\s+\d+\s*(?:yr|yrs?|mo|mos?|wk|wks?))*)/i
    );
    let age = ageMatch ? ageMatch[1].trim() : '';
    // Strip any trailing city/state that got concatenated (e.g. "1 yr 7 mosMerrill" -> "1 yr 7 mos")
    if (age) age = age.replace(/\s*(Merrill|Wausau|Friendship|,?\s*WI|Wisconsin)$/i, '').trim();

    let photo = p.photo;
    // Filter out Adoptapet's "New!" badge SVGs (not pet photos)
    if (photo && /new-badge/i.test(photo)) photo = null;
    // Filter placeholder/fallback URLs only if they don't end with a real pet image ID
    // Cloudinary d_Fallback-Photo_Dog-v3.png is a default-image directive, NOT the photo itself
    if (photo && /placeholder/i.test(photo) && !/\/\d{7,}(?:\?|$)/.test(photo)) photo = null;
    if (photo && photo.includes('adoptapet.com')) {
      // Extract the numeric pet image ID from the end of the Cloudinary URL
      const idMatch = photo.match(/\/(\d{7,})(?:\?|$)/);
      if (idMatch) {
        photo = `https://media.adoptapet.com/image/upload/c_auto,g_auto,w_400,ar_4:3,dpr_2/f_auto,q_auto/${idMatch[1]}`;
      } else {
        photo = photo.replace(/c_auto,g_auto,w_\d+,ar_[^/]+/, 'c_auto,g_auto,w_400,ar_4:3');
        photo = photo.replace(/dpr_\d+/, 'dpr_2');
      }
    }

    const species = classifySpecies(breed, p.url);

    // Clean up name: strip "My name is X!" prefix from Adoptapet detail pages
    let cleanName = (p.name || '').replace(/^My name is\s+/i, '').replace(/!$/, '').trim();

    return {
      name: cleanName,
      species,
      breed: breed || 'Unknown',
      age: age || p.ageFromPage || '',
      gender: gender || p.genderFromPage || '',
      bio: (p.bio || '').trim().substring(0, 1500) || '',
      photo,
      url: p.url
    };
  });
}

// ─── PETFINDER API ───
// Preferred over HTML scraping when credentials exist. Get a free key at
// https://www.petfinder.com/developers and set PETFINDER_API_KEY and
// PETFINDER_API_SECRET as GitHub Actions secrets to activate this path.
// Returns null when no credentials are configured; throws on API errors so
// the caller can fall back to the HTML scraper.
async function fetchPetfinderApi(orgId) {
  const key = process.env.PETFINDER_API_KEY, secret = process.env.PETFINDER_API_SECRET;
  if (!key || !secret) return null;
  const tokenRes = await fetch('https://api.petfinder.com/v2/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${encodeURIComponent(key)}&client_secret=${encodeURIComponent(secret)}`
  });
  if (!tokenRes.ok) throw new Error(`token HTTP ${tokenRes.status}`);
  const { access_token } = await tokenRes.json();
  const animals = [];
  let pageUrl = `https://api.petfinder.com/v2/animals?organization=${encodeURIComponent(orgId)}&status=adoptable&limit=100`;
  for (let page = 0; page < 5 && pageUrl; page++) {
    const res = await fetch(pageUrl, { headers: { Authorization: `Bearer ${access_token}` } });
    if (!res.ok) throw new Error(`animals HTTP ${res.status}`);
    const json = await res.json();
    animals.push(...(json.animals || []));
    const next = json.pagination && json.pagination._links && json.pagination._links.next;
    pageUrl = next ? `https://api.petfinder.com${next.href}` : null;
  }
  return animals.map(mapApiAnimal).filter(p => p.name);
}

/** Map a Petfinder API v2 animal object to the widget's standard pet shape */
function mapApiAnimal(a) {
  const decode = s => (s || '')
    .replace(/&amp;/g, '&').replace(/&#0?39;|&apos;|&rsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, '');
  const species = a.species === 'Cat' ? 'Cat' : a.species === 'Dog' ? 'Dog' : 'Other';
  const breeds = a.breeds || {};
  let breed = [breeds.primary, breeds.secondary].filter(Boolean).join(' / ');
  if (breeds.mixed && breed && !/mix/i.test(breed)) breed += ' Mix';
  const photo = (a.photos && a.photos[0] && (a.photos[0].large || a.photos[0].medium || a.photos[0].small)) || null;
  return {
    name: decode(a.name).trim(),
    species,
    breed: breed || 'Unknown',
    age: a.age || '',
    gender: a.gender || '',
    // API descriptions are truncated by Petfinder (~250 chars) — still better
    // than nothing, and the pet's detail page has the full story.
    bio: decode(a.description || '').trim(),
    photo,
    url: a.url ? a.url.split('?')[0] : '',
    // Real listing date — powers absolute "long-stay" tenure in the
    // featured-pet newsletter snapshot. Only present via the API path.
    publishedAt: a.published_at || null
  };
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
    await safeClose(page);

    const parsed = pets.map(p => {
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

    // Fetch bios from each pet's Petfinder detail page
    if (parsed.length > 0) {
      console.log(`  Fetching bios for ${parsed.length} Petfinder pets...`);
      let bioPage = null;
      for (let i = 0; i < parsed.length; i++) {
        const pet = parsed[i];
        try {
          if (!bioPage || bioPage.isClosed()) bioPage = await makePage(browser);
          await bioPage.goto(pet.url, { waitUntil: 'networkidle2', timeout: 15000 });
          await new Promise(r => setTimeout(r, 2000));

          // Dismiss cookie consent banner (Petfinder uses OneTrust)
          await bioPage.evaluate(() => {
            const reject = document.querySelector('#onetrust-reject-all-handler, [id*="reject"], .onetrust-close-btn-handler');
            if (reject) reject.click();
            // Also try generic cookie dismiss buttons
            const dismiss = [...document.querySelectorAll('button')].find(b => /reject|decline|close|dismiss|got it/i.test(b.textContent) && b.offsetParent);
            if (dismiss) dismiss.click();
          });
          await new Promise(r => setTimeout(r, 500));

          // Click "Read More" / "Show More" if present
          await bioPage.evaluate(() => {
            const candidates = [...document.querySelectorAll('button, a, span, [role="button"]')];
            const readMore = candidates.find(el => /^\s*(Read|Show)\s*more\s*$/i.test(el.textContent));
            if (readMore) readMore.click();
          });
          await new Promise(r => setTimeout(r, 800));

          const bio = await bioPage.evaluate(() => {
            // Skip cookie/legal text, site boilerplate — but NOT the word "Petfinder" in normal sentences
            const junk = /cookie|trademarks|Nestl[eé]|privacy|personali[sz]ation|advertising|third.party|browser.*block|Start Your Inquiry|^Share$|^Print$|sponsored|purina|unknown compatibility|compatibility with other|This pet has unknown|Manage Consent|Strictly Necessary/i;

            // Strategy 1: Look for "[Name]'s Story" heading (most reliable on Petfinder)
            const headings = [...document.querySelectorAll('h2, h3, h4')];
            const storyHeading = headings.find(h => /story/i.test(h.textContent) && h.textContent.length < 60 && !/compatibility/i.test(h.textContent));
            if (storyHeading) {
              // Get the parent section's visible text, then clip before junk starts
              const section = storyHeading.parentElement;
              if (section) {
                // Find the visible <p> with the story text (skip invisible ones)
                const allPs = [...section.querySelectorAll('p')];
                const visibleP = allPs.find(p => {
                  const style = window.getComputedStyle(p);
                  return style.display !== 'none' && style.visibility !== 'hidden' && style.height !== '0px' && p.offsetHeight > 0;
                });
                if (visibleP) {
                  // Get just the text nodes and inline element text, not nested block elements
                  let bioText = '';
                  const walker = document.createTreeWalker(visibleP, NodeFilter.SHOW_TEXT);
                  while (walker.nextNode()) {
                    const t = walker.currentNode.textContent.trim();
                    if (t) bioText += (bioText ? ' ' : '') + t;
                  }
                  bioText = bioText.replace(/\s+/g, ' ').trim();
                  // Cut before any junk text sneaks in
                  const junkIdx = bioText.search(/Please note|Start Your Inquiry|More About Us|Adoption Application|bit\.ly\//i);
                  if (junkIdx > 0) bioText = bioText.substring(0, junkIdx).trim();
                  bioText = bioText.replace(/\s*Read\s*more\s*$/i, '').replace(/\s*Show\s*less\s*$/i, '').trim();
                  if (bioText.length >= 50) return bioText.substring(0, 1500);
                }
              }
            }

            // Strategy 2: data-testid selectors
            const storyEl = document.querySelector(
              '[data-testid="pet-story"], [data-testid="pet-description"], ' +
              '[class*="pet-story"], [class*="pet_story"], [class*="petStory"]'
            );
            if (storyEl) {
              const t = storyEl.textContent.trim().replace(/\s+/g, ' ');
              if (t.length > 50 && !junk.test(t)) return t.substring(0, 1500);
            }

            // Strategy 3: "About [Name]" heading
            const aboutHeading = headings.find(h => /about/i.test(h.textContent) && h.textContent.length < 60);
            if (aboutHeading) {
              let out = '';
              let next = aboutHeading.nextElementSibling;
              while (next && !/^H[1-4]$/i.test(next.tagName)) {
                const t = next.textContent.trim().replace(/\s+/g, ' ');
                if (t.length > 30 && !junk.test(t)) {
                  out += (out ? ' ' : '') + t;
                }
                if (out.length >= 1500) break;
                next = next.nextElementSibling;
              }
              if (out.length >= 50) return out.replace(/\s*Read\s*more\s*$/i, '').substring(0, 1500);
            }

            // Strategy 4: Fallback to paragraphs
            const paras = [...document.querySelectorAll('main p, article p')];
            let out = '';
            for (const para of paras) {
              const t = para.textContent.trim().replace(/\s+/g, ' ');
              if (t.length < 50) continue;
              if (junk.test(t)) continue;
              out += (out ? ' ' : '') + t;
              if (out.length >= 1500) break;
            }
            return out ? out.replace(/\s*Read\s*more\s*$/i, '').replace(/\s*Read\s*less\s*$/i, '').trim().substring(0, 1500) : '';
          });

          if (bio && bio.length >= 50 && !/unknown compatibility|This pet has unknown/i.test(bio)) {
            pet.bio = bio.replace(/`/g, "'");
          }
        } catch (err) {
          // Skip bio on error; recreate the page next iteration if it died
          await safeClose(bioPage);
          bioPage = null;
          if (!browser.connected) {
            console.log(`    Browser connection lost — skipping remaining ${parsed.length - i - 1} bios`);
            break;
          }
        }
        if ((i + 1) % 5 === 0) console.log(`    Bios: ${i + 1}/${parsed.length}`);
        await new Promise(r => setTimeout(r, 600));
      }
      await safeClose(bioPage);
    }

    return parsed;

  } catch (err) {
    console.error(`  Error: ${err.message}`);
    await safeClose(page);
    return [];
  }
}

// ─── NLPAC SCRAPER (New Life Pet Adoption Center) ───
// Uses Puppeteer + stealth because the site now sits behind Cloudflare's
// "Just a moment..." challenge, which blocks plain HTTP fetches.
async function scrapeNlpac(browser) {
  const url = 'https://www.nlpac.com/pets';
  console.log(`\n[nlpac] Scraping: ${url}`);

  const listPage = await makePage(browser);
  let listHtml = '';
  try {
    await listPage.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    // Cloudflare challenge can take a few seconds to clear after the JS runs
    await new Promise(r => setTimeout(r, 5000));
    listHtml = await listPage.content();

    if (/Just a moment\.\.\.|cf-browser-verification|cf_chl_opt/i.test(listHtml)) {
      // Wait a bit longer for CF to clear, then retry
      await new Promise(r => setTimeout(r, 8000));
      listHtml = await listPage.content();
    }

    if (/Just a moment\.\.\.|cf-browser-verification|cf_chl_opt/i.test(listHtml)) {
      console.log('  [nlpac] Cloudflare did not clear — saving diagnostic');
      saveDiag('nlpac-list', listHtml);
      await safeClose(listPage);
      return [];
    }
  } catch (err) {
    console.error(`  Error loading listing: ${err.message}`);
    try { saveDiag('nlpac-list', await listPage.content()); } catch (_) {}
    await safeClose(listPage);
    return [];
  }

  // Extract per-pet card data from the listing page DOM. The listing is
  // server-rendered and carries name, breed, photo, and a short bio for
  // every pet — enough to build complete cards even when Cloudflare blocks
  // the detail pages (which it does aggressively for datacenter IPs like
  // GitHub Actions runners).
  const listingCards = await listPage.evaluate(() => {
    const cards = [];
    document.querySelectorAll('figure.featured-pet-widget').forEach(fig => {
      const a = fig.querySelector('a[href*="/q/pets/"]');
      if (!a) return;
      const path = a.getAttribute('href');
      const nameEl = fig.querySelector('.pet-name .text span');
      const name = nameEl ? nameEl.textContent.trim() : '';
      const textEl = fig.querySelector('.pet-name .text');
      let breed = textEl ? textEl.textContent.replace(/\s+/g, ' ').trim() : '';
      if (name && breed.startsWith(name)) breed = breed.slice(name.length).trim();
      const bioEl = fig.querySelector('figcaption p');
      const bio = bioEl ? bioEl.textContent.replace(/ /g, ' ').replace(/\s+/g, ' ').trim() : '';
      let photo = null;
      const imgDiv = fig.querySelector('.pet-img');
      if (imgDiv) {
        const m = (imgDiv.getAttribute('style') || '').match(/url\(['"]?([^'")]+)['"]?\)/i);
        if (m) photo = m[1];
      }
      cards.push({ path, name, breed, bio, photo });
    });
    return cards;
  });

  // Pet paths: union of listing cards and raw href regex (belt and braces
  // in case the card markup changes)
  const linkMatches = listHtml.match(/href="(\/q\/pets\/[^"]+)"/g) || [];
  const petPaths = [...new Set([
    ...listingCards.map(c => c.path),
    ...linkMatches.map(m => m.match(/href="([^"]+)"/)?.[1]).filter(Boolean)
  ])];

  console.log(`  Found ${petPaths.length} pet links (${listingCards.length} with listing-card data), fetching details...`);
  if (petPaths.length === 0) {
    saveDiag('nlpac-list', listHtml);
    await safeClose(listPage);
    return [];
  }
  const cardByPath = new Map(listingCards.map(c => [c.path, c]));

  // Build a complete pet object from listing-card data alone — used whenever
  // the detail page can't be reached. Breed text like "Domestic Short Hair -
  // gray and white" and the short bio ("Breckie is a male American Eskimo.")
  // give us species and gender.
  const baseFromCard = (card, petUrl) => {
    if (!card || !card.name) return null;
    const g = (card.bio || '').match(/\b(male|female)\b/i);
    return {
      name: card.name,
      species: classifySpecies(card.breed, ''),
      breed: card.breed || '',
      age: '',
      gender: g ? g[1].charAt(0).toUpperCase() + g[1].slice(1).toLowerCase() : '',
      bio: card.bio || '',
      photo: card.photo,
      url: petUrl
    };
  };

  // Reuse the listing page for all detail visits. New pages get fresh
  // browser contexts → fresh Cloudflare challenge each time. Reusing the
  // same page preserves the cf_clearance cookie + browser fingerprint so
  // CF treats subsequent navigations as the same already-verified visitor.
  // Detail visits are ENRICHMENT only: every pet already has a usable card
  // from the listing data, so a challenged detail page downgrades gracefully
  // instead of dropping the pet.
  const petPage = listPage;
  const allPets = [];
  let firstFailureSaved = false;
  let consecutiveCfFailures = 0;
  let enriched = 0, listingOnly = 0;
  for (const petPath of petPaths) {
    const petUrl = `https://www.nlpac.com${petPath}`;
    const basePet = baseFromCard(cardByPath.get(petPath), petUrl);

    // Once 3 detail pages in a row stay challenged, CF is blocking this
    // runner — stop burning ~40s per pet and ship listing data for the rest.
    if (consecutiveCfFailures >= 3) {
      if (basePet) { allPets.push(basePet); listingOnly++; }
      continue;
    }

    try {
      await petPage.goto(petUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      // Cloudflare often greets detail pages with the "Just a moment..."
      // challenge page. Actively poll for the title to change rather than
      // guessing how long the verification will take.
      try {
        await petPage.waitForFunction(
          () => !/^Just a moment/i.test(document.title),
          { timeout: 12000, polling: 500 }
        );
        consecutiveCfFailures = 0;
      } catch (_) {
        // Timed out — page is still challenged. Fall back to listing data.
        consecutiveCfFailures++;
        if (!firstFailureSaved) {
          firstFailureSaved = true;
          const html = await petPage.content();
          saveDiag(`nlpac-pet-${petPath.split('/').pop()}-cf-stuck`, html);
          console.log(`    [nlpac] CF challenge did not clear on ${petPath} after 12s — diagnostic saved`);
        }
        if (basePet) {
          allPets.push(basePet);
          listingOnly++;
          console.log(`    ${basePet.name} (${basePet.species}) - ${basePet.breed} [listing data only]`);
        }
        continue;
      }
      // Settle after the challenge clears so the SPA hydrates
      await new Promise(r => setTimeout(r, 1500));

      // DOM-based extraction (post-JS render). More robust than HTML regex
      // because pet pages have structured content with nested tags inside <h1>.
      const data = await petPage.evaluate(() => {
        const text = el => el ? el.textContent.trim().replace(/\s+/g, ' ') : '';

        // Name: prefer h1 text content (handles nested tags). Strip "Meet"/"!"
        let name = text(document.querySelector('h1'));
        name = name.replace(/^Meet\s+/i, '').replace(/!+$/, '').trim();

        // Structured info: every "Key: Value" <li> on the page
        const info = {};
        document.querySelectorAll('li').forEach(li => {
          const t = li.textContent.trim().replace(/\s+/g, ' ');
          const m = t.match(/^([A-Za-z][A-Za-z ]+?):\s*(.+)$/);
          if (m && m[2].length < 200) info[m[1].trim()] = m[2].trim();
        });

        // Photo: any custompages image (NLPAC's CDN), prefer larger ones
        let photo = null;
        const imgs = [...document.querySelectorAll('img')]
          .map(i => i.src)
          .filter(s => s && /custompages/i.test(s) && !/logo|nav|icon/i.test(s));
        if (imgs.length) photo = imgs[0];

        // Bio: first substantial paragraph that isn't site-chrome
        let bio = '';
        const junk = /Contact|©|PayPal|security service|powered by|cookie|privacy/i;
        for (const p of document.querySelectorAll('p, .description, .bio')) {
          const t = p.textContent.trim().replace(/\s+/g, ' ');
          if (t.length > 50 && !junk.test(t)) { bio = t.substring(0, 1500); break; }
        }

        return { name, info, photo, bio };
      });

      if (!data.name || data.name.includes('www.') || data.name.includes('.com')) {
        if (!firstFailureSaved) {
          firstFailureSaved = true;
          const html = await petPage.content();
          saveDiag(`nlpac-pet-${petPath.split('/').pop()}`, html);
          console.log(`    [nlpac] No name extracted for ${petPath} (h1 was "${data.name}") — diagnostic saved`);
        }
        if (basePet) { allPets.push(basePet); listingOnly++; }
        continue;
      }

      const animalType = data.info['Animal Type'] || '';
      const breed = data.info['Breed'] || (basePet ? basePet.breed : '');
      const age = data.info['Age'] || '';
      const gender = data.info['Gender'] || data.info['Sex'] || (basePet ? basePet.gender : '');

      let species;
      if (animalType.toLowerCase().includes('cat')) species = 'Cat';
      else if (animalType.toLowerCase().includes('dog')) species = 'Dog';
      else if (/guinea|hamster|rabbit|ferret|bird/i.test(animalType + ' ' + breed)) species = 'Other';
      else species = classifySpecies(breed, '');

      const pet = {
        name: data.name, species, breed, age, gender,
        bio: data.bio || (basePet ? basePet.bio : ''),
        photo: data.photo || (basePet ? basePet.photo : null),
        url: petUrl
      };
      console.log(`    ${data.name} (${species}) - ${breed}${pet.photo ? '' : ' [no photo]'}`);
      allPets.push(pet);
      enriched++;
    } catch (err) {
      console.error(`    Error on ${petUrl}: ${err.message}`);
      if (basePet) { allPets.push(basePet); listingOnly++; }
    }
    await new Promise(r => setTimeout(r, 400));
  }
  await safeClose(petPage);

  console.log(`  [nlpac] TOTAL: ${allPets.length} pets (${enriched} full detail, ${listingOnly} listing-only)`);
  return allPets;
}

// ─── MAIN ───
async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  Wausau Pilot & Review — Pet Data Builder       ║');
  console.log('╚══════════════════════════════════════════════════╝\n');
  
  const launchBrowser = () => puppeteer.launch({
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
  let browser = await launchBrowser();

  // A single shelter's fatal error (e.g. a Chrome crash mid-scrape, as on
  // 2026-07-26) must not kill the whole build. Log it, publish [] for that
  // shelter — carry-forward serves its last good data and the health gate
  // flags it — and relaunch Chrome for the next shelter if it died.
  const scrapeSafe = async (key, fn) => {
    try {
      if (!browser.connected) {
        console.log(`\n[${key}] Browser was disconnected — relaunching Chrome`);
        try { await browser.close(); } catch (_) {}
        browser = await launchBrowser();
      }
      return await fn();
    } catch (err) {
      console.error(`\n[${key}] SCRAPE CRASHED: ${err.message} — continuing with remaining shelters`);
      return [];
    }
  };
  
  const data = {
    lastUpdated: new Date().toISOString(),
    shelters: {}
  };

  // Previous run's output — used to carry forward last-known-good listings
  // when a scrape comes back empty (bot block, layout change, site outage).
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8')); } catch (_) {}
  
  // Marathon County — Adoptapet
  data.shelters.marathon = await scrapeSafe('marathon', () => scrapeAdoptapet(
    browser,
    '77626-humane-society-of-marathon-county-wausau-wisconsin',
    'marathon'
  ));
  
  // Clark County — Petfinder. Official API when credentials are configured
  // (reliable, structured data); HTML scraper otherwise or on any API error.
  data.shelters.clark = null;
  try {
    const apiPets = await fetchPetfinderApi('WI34');
    if (apiPets && apiPets.length > 0) {
      console.log(`\n[clark] Petfinder API: ${apiPets.length} pets`);
      data.shelters.clark = apiPets;
    } else if (apiPets) {
      console.log('\n[clark] Petfinder API returned 0 pets — falling back to HTML scrape');
    }
  } catch (err) {
    console.log(`\n[clark] Petfinder API failed (${err.message}) — falling back to HTML scrape`);
  }
  if (!data.shelters.clark) {
    data.shelters.clark = await scrapeSafe('clark', () => scrapePetfinder(
      browser,
      'neillsville/clark-county-humane-society-wi34',
      'clark'
    ));
  }
  
  // Adams County — Adoptapet
  data.shelters.adams = await scrapeSafe('adams', () => scrapeAdoptapet(
    browser,
    '76343-adams-county-humane-society-friendship-wisconsin',
    'adams'
  ));
  
  // Lincoln County — Adoptapet only.
  // furrypets.com no longer lists individual pets (moved to "application-first" model),
  // so the previous direct scrape was a dead path.
  data.shelters.lincoln = await scrapeSafe('lincoln', () => scrapeAdoptapet(
    browser,
    '66070-lincoln-county-humane-society-merrill-wisconsin',
    'lincoln'
  ));

  // New Life Pet Adoption Center — Puppeteer required (Cloudflare blocks plain HTTP)
  data.shelters.nlpac = await scrapeSafe('nlpac', () => scrapeNlpac(browser));

  // Fetch Foster and Rescue — Adoptapet (dogs only, foster-based rescue in Wausau)
  data.shelters.fetch = await scrapeSafe('fetch', () => scrapeAdoptapet(
    browser,
    '151032-fetch-foster-and-rescue-inc-wausau-wisconsin',
    'fetch'
  ));

  // South Wood County Humane Society — Wisconsin Rapids (Adoptapet)
  data.shelters.southwood = await scrapeSafe('southwood', () => scrapeAdoptapet(
    browser,
    '20247-south-wood-county-humane-society-wisconsin-rapids-wisconsin',
    'southwood'
  ));

  // Marshfield Area Pet Shelter — Marshfield (Adoptapet)
  data.shelters.marshfield = await scrapeSafe('marshfield', () => scrapeAdoptapet(
    browser,
    '96724-marshfield-area-pet-shelter-marshfield-wisconsin',
    'marshfield'
  ));

  // Humane Society of Portage County — Plover/Stevens Point (Adoptapet)
  data.shelters.portage = await scrapeSafe('portage', () => scrapeAdoptapet(
    browser,
    '87863-humane-society-of-portage-county-plover-wisconsin',
    'portage'
  ));

  // Taylor County WI Humane Society — Medford (Adoptapet)
  data.shelters.taylor = await scrapeSafe('taylor', () => scrapeAdoptapet(
    browser,
    '81472-taylor-county-wi-humane-society-medford-wisconsin',
    'taylor'
  ));

  try { await browser.close(); } catch (_) {}

  // Cross-shelter dedup: Adoptapet cross-lists pets across nearby shelters.
  // Remove duplicates so the same pet doesn't appear under both Marathon and Fetch.
  // Priority order: marathon > clark > adams > lincoln > nlpac > fetch (keep first occurrence)
  const seenUrls = new Set();
  const shelterOrder = ['marathon', 'clark', 'adams', 'lincoln', 'nlpac', 'fetch', 'southwood', 'marshfield', 'portage', 'taylor'];
  for (const key of shelterOrder) {
    if (!data.shelters[key]) continue;
    const before = data.shelters[key].length;
    data.shelters[key] = data.shelters[key].filter(p => {
      if (seenUrls.has(p.url)) return false;
      seenUrls.add(p.url);
      return true;
    });
    const removed = before - data.shelters[key].length;
    if (removed > 0) console.log(`  [dedup] Removed ${removed} cross-listed pets from ${key}`);
  }

  // Lincoln County HS is application-first with no scrapeable individual
  // listings — always present browse/apply link-out cards. This runs BEFORE
  // carry-forward so Lincoln is never treated as an empty/stale outage.
  data.shelters.lincoln = ensureLincolnLinkouts(data.shelters.lincoln);

  // Carry forward last-known-good listings when a scrape returns nothing.
  // An empty result almost always means a bot block or layout change, not an
  // empty shelter — yesterday's real pets beat months-old hardcoded fallback.
  // Carried data expires after MAX_STALE_DAYS so adopted pets don't linger.
  const MAX_STALE_DAYS = 14;
  const staleSince = {};
  for (const key of Object.keys(data.shelters)) {
    if (data.shelters[key].length > 0) continue;
    const prevPets = previous && previous.shelters && previous.shelters[key];
    if (!Array.isArray(prevPets) || prevPets.length === 0) continue;
    const since = (previous.scrape_status && previous.scrape_status[key] && previous.scrape_status[key].staleSince) || previous.lastUpdated;
    const ageDays = (Date.now() - new Date(since).getTime()) / 86400000;
    if (!since || isNaN(ageDays) || ageDays > MAX_STALE_DAYS) {
      console.log(`  [carry] ${key}: scrape returned 0 and last good data is too old to reuse`);
      continue;
    }
    data.shelters[key] = prevPets;
    staleSince[key] = since;
    console.log(`  [carry] ${key}: scrape returned 0 — carried forward ${prevPets.length} pets from last good run (stale since ${since})`);
  }


  computeFirstSeen(previous, data);

  // Health check: classify each shelter as ok / low / failed so a silent outage
  // shows up in the JSON instead of just looking like a quiet day.
  // EXPECTED_MIN = a floor below which we treat the result as suspicious. Tuned
  // from observed steady-state counts. lincoln is application-first: it always
  // carries its 2 link-out cards, so 1 is a safe floor that never trips.
  const EXPECTED_MIN = {
    marathon: 20, clark: 10, adams: 5, lincoln: 1, nlpac: 3, fetch: 5,
    southwood: 10, marshfield: 3, portage: 15, taylor: 8
  };
  data.scrape_status = {};
  for (const [key, pets] of Object.entries(data.shelters)) {
    const count = pets.length;
    let status = 'ok';
    if (staleSince[key]) status = 'stale';
    else if (count === 0) status = 'failed';
    else if (count < (EXPECTED_MIN[key] ?? 1)) status = 'low';
    data.scrape_status[key] = { count, status, expected_min: EXPECTED_MIN[key] ?? 1 };
    if (staleSince[key]) data.scrape_status[key].staleSince = staleSince[key];
  }

  // Summary
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  RESULTS                                        ║');
  console.log('╠══════════════════════════════════════════════════╣');
  let total = 0;
  for (const [key, pets] of Object.entries(data.shelters)) {
    const dogs = pets.filter(p => p.species === 'Dog').length;
    const cats = pets.filter(p => p.species === 'Cat').length;
    const mark = { ok: ' ', low: '!', stale: '~' }[data.scrape_status[key].status] || 'X';
    console.log(`║ ${mark}${key.padEnd(11)} ${String(pets.length).padStart(3)} pets (${dogs} dogs, ${cats} cats)`.padEnd(51) + '║');
    total += pets.length;
  }
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  TOTAL: ${total} pets`.padEnd(51) + '║');
  const failed = Object.entries(data.scrape_status).filter(([,s]) => s.status === 'failed').map(([k]) => k);
  const low = Object.entries(data.scrape_status).filter(([,s]) => s.status === 'low').map(([k]) => k);
  const stale = Object.entries(data.scrape_status).filter(([,s]) => s.status === 'stale').map(([k]) => k);
  if (failed.length) console.log(`║  FAILED: ${failed.join(', ')}`.padEnd(51) + '║');
  if (low.length) console.log(`║  LOW:    ${low.join(', ')}`.padEnd(51) + '║');
  if (stale.length) console.log(`║  STALE:  ${stale.join(', ')}`.padEnd(51) + '║');
  console.log('╚══════════════════════════════════════════════════╝');
  
  // Write output
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2));
  console.log(`\n✅ Saved to ${OUTPUT_FILE}`);

  injectIntoWidget(data, path.join(__dirname, 'adopt-widget.html'));
}

/**
 * Track when each pet first appeared so the widget can badge new arrivals
 * and spotlight the longest-waiting animals. Persists a url → ISO-date map
 * in pet-data.json (data.firstSeen) and stamps each pet object.
 *
 * Pets already listed when tracking began get null (age unknown) rather
 * than a misleading "new" date — and that null is persisted so they never
 * get mistaken for new arrivals later. Entries for pets that vanish are
 * kept (scrape hiccups happen; a reappearing pet keeps its original date)
 * unless the map balloons past 3000 entries.
 */
function computeFirstSeen(previous, data) {
  const prevSeen = (previous && previous.firstSeen) || null;
  data.firstSeen = {};
  for (const pets of Object.values(data.shelters)) {
    for (const pet of pets) {
      if (!pet.url || pet.placeholder) continue; // skip link-out/placeholder cards
      let seen;
      if (prevSeen && Object.prototype.hasOwnProperty.call(prevSeen, pet.url)) seen = prevSeen[pet.url];
      else if (!prevSeen) seen = null; // tracking starts now; existing pets have unknown age
      else seen = data.lastUpdated;    // genuinely new since the last run
      data.firstSeen[pet.url] = seen;
      if (seen) pet.firstSeen = seen;
    }
  }
  if (prevSeen) {
    for (const [url, seen] of Object.entries(prevSeen)) {
      if (!(url in data.firstSeen) && Object.keys(data.firstSeen).length < 3000) {
        data.firstSeen[url] = seen;
      }
    }
  }
  const newCount = Object.values(data.shelters).flat().filter(p => p.firstSeen === data.lastUpdated).length;
  if (newCount > 0) console.log(`  [firstSeen] ${newCount} new pet(s) since last run`);
}

/**
 * Refresh the widget's baked-in fallback so it is never older than the last
 * successful build. Replaces the marker-delimited FALLBACK_DATA and
 * FALLBACK_META blocks in adopt-widget.html. The JSON is embedded inside a
 * <script> tag, so "<" is escaped to keep a literal "</script>" in a pet bio
 * from terminating the script element.
 */
function injectIntoWidget(data, widgetPath) {
  if (!fs.existsSync(widgetPath)) return;
  const html = fs.readFileSync(widgetPath, 'utf8');
  const embed = obj => JSON.stringify(obj).replace(/</g, '\\u003c');
  const blocks = [
    {
      name: 'FALLBACK_DATA',
      re: /\/\*FALLBACK_DATA_START\*\/[\s\S]*?\/\*FALLBACK_DATA_END\*\//,
      text: `/*FALLBACK_DATA_START*/\nconst FALLBACK_DATA=${embed(data.shelters)};\n/*FALLBACK_DATA_END*/`
    },
    {
      name: 'FALLBACK_META',
      re: /\/\*FALLBACK_META_START\*\/[\s\S]*?\/\*FALLBACK_META_END\*\//,
      text: `/*FALLBACK_META_START*/\nconst FALLBACK_META=${embed({ lastUpdated: data.lastUpdated, scrape_status: data.scrape_status })};\n/*FALLBACK_META_END*/`
    }
  ];
  let out = html;
  for (const { name, re, text } of blocks) {
    if (!re.test(out)) {
      console.warn(`⚠️  ${name} markers not found in adopt-widget.html — fallback NOT refreshed`);
      return;
    }
    // Replacement via function so "$" sequences in pet bios aren't treated as substitution patterns
    out = out.replace(re, () => text);
  }
  fs.writeFileSync(widgetPath, out);
  console.log('✅ Refreshed FALLBACK_DATA + FALLBACK_META in adopt-widget.html');
}

module.exports = { classifySpecies, injectIntoWidget, scrapeNlpac, scrapeAdoptapet, computeFirstSeen, fetchPetfinderApi, mapApiAnimal, ensureLincolnLinkouts, LINCOLN_LINKOUTS };

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
