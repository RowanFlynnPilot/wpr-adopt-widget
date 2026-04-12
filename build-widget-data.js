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

// ─── ADOPTAPET SCRAPER ───
// Adoptapet uses client-side pagination. The shelter page shows 12 pets/page but
// /pet-search shows 42/page and is more reliable. Try search URL first, fall back to shelter page.
const SHELTER_POSTAL = { '77626': '54401', '76343': '53934', '66070': '54452', '151032': '54401' };

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
              name = (cleaned || name.substring(0, 30)).trim();
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
    await page.close();
  }

  // Fallback: if card-based scraping found very few results, extract pet URLs from
  // the page's raw HTML/script data. Adoptapet is a Next.js React app — after JS
  // hydration, pet cards may be re-rendered with fewer visible than the server-
  // rendered HTML contained. This fallback catches pets embedded in RSC payloads.
  // Trigger fallback if we got less than half the expected total (pagination likely failed)
  const needsFallback = totalExpected > 0 ? allPets.length < totalExpected * 0.5 : allPets.length <= 3;
  if (needsFallback) {
    console.log(`  [${shelterKey}] Only ${allPets.length} pets from cards (expected ${totalExpected || '?'}) — trying HTML fallback...`);
    const fallbackPage = await makePage(browser);
    // Use shelter page for fallback (different HTML structure, may have more embedded URLs)
    const fallbackUrl = `${baseUrl}/available-pets`;
    try {
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
    await fallbackPage.close();
  }

  console.log(`  [${shelterKey}] TOTAL: ${allPets.length} pets scraped`);
  
  // Deduplicate by URL
  const unique = new Map();
  allPets.forEach(p => { if (!unique.has(p.url)) unique.set(p.url, p); });
  allPets = Array.from(unique.values());

  // Fetch bio from each pet's detail page (Adoptapet lists only name/breed/age on listing)
  if (allPets.length > 0) {
    console.log(`  Fetching bios for ${allPets.length} pets...`);
    for (let i = 0; i < allPets.length; i++) {
      const pet = allPets[i];
      const bioPage = await makePage(browser);
      try {
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
      }
      await bioPage.close();
      if ((i + 1) % 10 === 0) console.log(`    Bios: ${i + 1}/${allPets.length}`);
      await new Promise(r => setTimeout(r, 600));
    }
  }
  
  // Filter out pets with no name or error page names
  allPets = allPets.filter(p => {
    if (!p.name || p.name.length === 0) return false;
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

    const lowerAll = `${breed} ${p.name} ${raw} ${(p.url || '')}`.toLowerCase();

    const isCat =
      /shorthair|longhair|siamese|tabby|calico|persian|bengal|ragdoll/.test(
        (breed || '').toLowerCase()
      ) || /-cat$|-wisconsin-cat/.test(p.url || '');

    const isOther = /rat|mouse|mice|hamster|guinea|cavy|rabbit|bunny|ferret|gerbil|hedgehog|chinchilla|lizard|reptile|turtle|tortoise|snake|gecko|parakeet|cockatiel|parrot|bird|finch|canary|small animal|rodent/.test(
      lowerAll
    );

    let species = 'Dog';
    if (isCat) species = 'Cat';
    else if (isOther) species = 'Other';

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
      for (let i = 0; i < parsed.length; i++) {
        const pet = parsed[i];
        const bioPage = await makePage(browser);
        try {
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
          // Skip bio on error
        }
        await bioPage.close();
        if ((i + 1) % 5 === 0) console.log(`    Bios: ${i + 1}/${parsed.length}`);
        await new Promise(r => setTimeout(r, 600));
      }
    }

    return parsed;

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
                  bio: (desc?.textContent || '').trim().substring(0, 1500),
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
// Uses plain HTTP fetch instead of Puppeteer to avoid Cloudflare bot detection.
// The site serves pet data in plain HTML — no JS execution needed.
async function scrapeNlpac() {
  const url = 'https://www.nlpac.com/pets';
  console.log(`\n[nlpac] Scraping (HTTP): ${url}`);

  const https = require('https');

  function fetchPage(pageUrl) {
    return new Promise((resolve, reject) => {
      const req = https.get(pageUrl, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        }
      }, (res) => {
        // Follow redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirect = new URL(res.headers.location, pageUrl).href;
          fetchPage(redirect).then(resolve).catch(reject);
          return;
        }
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
    });
  }

  try {
    const html = await fetchPage(url);

    // Check for Cloudflare block
    if (html.includes('Just a moment') || html.includes('cf-browser-verification')) {
      console.log('  [nlpac] Cloudflare blocked HTTP request, saving diagnostic');
      saveDiag('nlpac-list', html);
      return [];
    }

    // Extract pet links: /q/pets/petname
    const linkMatches = html.match(/href="(\/q\/pets\/[^"]+)"/g) || [];
    const petPaths = [...new Set(
      linkMatches.map(m => m.match(/href="([^"]+)"/)?.[1]).filter(Boolean)
    )];

    console.log(`  Found ${petPaths.length} pet links, fetching details...`);
    if (petPaths.length === 0) {
      saveDiag('nlpac-list', html);
      return [];
    }

    const allPets = [];
    for (const petPath of petPaths) {
      const petUrl = `https://www.nlpac.com${petPath}`;
      try {
        const petHtml = await fetchPage(petUrl);

        // Skip Cloudflare-blocked pages
        if (petHtml.includes('Just a moment')) continue;

        // Extract name from <h1> (often "Meet Petname" or just "Petname")
        const nameMatch = petHtml.match(/<h1[^>]*>(.*?)<\/h1>/i);
        let name = (nameMatch?.[1] || '').replace(/<[^>]+>/g, '').replace(/^Meet\s+/i, '').trim();
        if (!name || name.includes('www.') || name.includes('.com')) continue;

        // Extract photo: look for custompages image
        const photoMatch = petHtml.match(/src="(https?:\/\/[^"]*custompages[^"]*)"/i);
        const photo = photoMatch?.[1] || null;

        // Extract structured info from <li> elements: "Key: Value"
        const info = {};
        const liMatches = petHtml.match(/<li[^>]*>(.*?)<\/li>/gi) || [];
        for (const li of liMatches) {
          const text = li.replace(/<[^>]+>/g, '').trim();
          const kvMatch = text.match(/^(.+?):\s*(.+)$/);
          if (kvMatch) info[kvMatch[1].trim()] = kvMatch[2].trim();
        }

        // Extract bio: find paragraphs with substantial text
        let bio = '';
        const paraMatches = petHtml.match(/<p[^>]*>(.*?)<\/p>/gi) || [];
        for (const p of paraMatches) {
          const text = p.replace(/<[^>]+>/g, '').trim().replace(/\s+/g, ' ');
          if (text.length > 50 && !bio && !/Contact|©|PayPal|security service/i.test(text)) {
            bio = text.substring(0, 1500);
          }
        }

        const animalType = info['Animal Type'] || '';
        const breed = info['Breed'] || '';
        const age = info['Age'] || '';

        let species = 'Dog';
        if (animalType.toLowerCase().includes('cat')) species = 'Cat';
        else if (/guinea|hamster|rabbit|ferret|bird/i.test(animalType + ' ' + breed)) species = 'Other';

        const pet = { name, species, breed, age, gender: '', bio, photo, url: petUrl };
        console.log(`    ${name} (${species}) - ${breed}${photo ? '' : ' [no photo]'}`);
        allPets.push(pet);

        // Small delay between requests to be polite
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        console.error(`    Error on ${petUrl}: ${err.message}`);
      }
    }

    console.log(`  [nlpac] TOTAL: ${allPets.length} pets`);
    return allPets;

  } catch (err) {
    console.error(`  Error: ${err.message}`);
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
  
  // Lincoln County — scrape furrypets.com directly (primary), merge with Adoptapet (fallback)
  const lincolnDirect = await scrapeLincoln(browser);
  const lincolnAdoptapet = await scrapeAdoptapet(
    browser,
    '66070-lincoln-county-humane-society-merrill-wisconsin',
    'lincoln'
  );
  // Merge: prefer direct scrape results, add any Adoptapet-only pets
  const lincolnUrls = new Set(lincolnDirect.map(p => p.url));
  const adoptapetOnly = lincolnAdoptapet.filter(p => !lincolnUrls.has(p.url));
  data.shelters.lincoln = [...lincolnDirect, ...adoptapetOnly];
  
  // New Life Pet Adoption Center — plain HTTP scrape (avoids Cloudflare bot detection)
  data.shelters.nlpac = await scrapeNlpac();

  // Fetch Foster and Rescue — Adoptapet (dogs only, foster-based rescue in Wausau)
  data.shelters.fetch = await scrapeAdoptapet(
    browser,
    '151032-fetch-foster-and-rescue-inc-wausau-wisconsin',
    'fetch'
  );

  await browser.close();

  // Cross-shelter dedup: Adoptapet cross-lists pets across nearby shelters.
  // Remove duplicates so the same pet doesn't appear under both Marathon and Fetch.
  // Priority order: marathon > clark > adams > lincoln > nlpac > fetch (keep first occurrence)
  const seenUrls = new Set();
  const shelterOrder = ['marathon', 'clark', 'adams', 'lincoln', 'nlpac', 'fetch'];
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
