import axios from 'axios';

async function testAll(riskName: string) {
  console.log(`=== Testing Live Searches for: "${riskName}" ===\n`);

  // 1. Google News RSS
  try {
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(riskName)}&hl=en-US&gl=US&ceid=US:en`;
    const res = await axios.get(rssUrl, { timeout: 4000 });
    const items = res.data.match(/<item>[\s\S]*?<\/item>/g) || [];
    if (items.length > 0) {
      const title = items[0].match(/<title>(.*?)<\/title>/)?.[1];
      const link = items[0].match(/<link>(.*?)<\/link>/)?.[1] || items[0].match(/<link\/>(.*?)/)?.[1];
      console.log('✅ Google News Top Article:', { title, link });
    }
  } catch (e: any) {
    console.log('Google News err:', e.message);
  }

  // 2. SEC EDGAR API
  try {
    const url = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(riskName)}&forms=8-K`;
    const res = await axios.get(url, {
      headers: { 'User-Agent': 'EmaRiskAgent/1.0 (compliance@wissda.com)' },
      timeout: 4000
    });
    const hits = res.data?.hits?.hits || [];
    if (hits.length > 0) {
      const top = hits[0]._source;
      const entity = top.display_names?.[0] || top.entity_name;
      console.log('✅ SEC EDGAR Top Filing:', { entity, form: top.form, file_date: top.file_date });
    }
  } catch (e: any) {
    console.log('SEC EDGAR err:', e.message);
  }

  // 3. Reddit Search API
  try {
    const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(riskName)}&sort=relevance&limit=3`;
    const res = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 4000
    });
    const posts = res.data?.data?.children || [];
    if (posts.length > 0) {
      const topPost = posts[0].data;
      console.log('✅ Reddit Top Discussion:', {
        title: topPost.title,
        url: `https://www.reddit.com${topPost.permalink}`
      });
    }
  } catch (e: any) {
    console.log('Reddit err:', e.message);
  }
}

testAll('AML BSA Compliance Program Weakness');
