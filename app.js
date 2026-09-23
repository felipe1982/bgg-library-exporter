// app.js
const CORS_PROXY = 'https://api.allorigins.win/raw?url=';
const BGG_API_BASE = 'https://boardgamegeek.com/xmlapi2';
const GEEKDO_API_BASE = 'https://api.geekdo.com/api';

document.getElementById('search-btn').addEventListener('click', initiateSearch);

async function initiateSearch() {
    const username = document.getElementById('username').value.trim();
    const country = document.getElementById('country').value.trim().toLowerCase();
    
    if (!username || !country) {
        alert('Please enter both a username and a country.');
        return;
    }

    toggleLoading(true, 'Fetching wishlist from BGG...');
    clearResults();

    try {
        const wishlist = await fetchWishlist(username);
        
        if (wishlist.length === 0) {
            toggleLoading(false);
            alert('No wishlist items found, user does not exist, or BGG is still processing. Please try again in a moment.');
            return;
        }

        const allResults = [];
        const total = wishlist.length;

        for (let i = 0; i < total; i++) {
            const game = wishlist[i];
            updateLoadingText(`Checking market/trades for: ${game.name} (${i + 1}/${total})`);
            
            const [trades, sales] = await Promise.all([
                fetchTrades(game.id, country),
                fetchSales(game.id, country)
            ]);

            trades.forEach(trade => {
                allResults.push({
                    gameName: game.name,
                    thumbnail: game.thumbnail,
                    username: trade.username,
                    type: 'Trade',
                    price: null,
                    link: `https://boardgamegeek.com/user/${trade.username}`
                });
            });

            sales.forEach(sale => {
                allResults.push({
                    gameName: game.name,
                    thumbnail: game.thumbnail,
                    username: sale.username,
                    type: 'Sale',
                    price: sale.price,
                    link: `https://boardgamegeek.com/market/product/${sale.marketId}`
                });
            });

            // Throttling to prevent IP blocks (2 seconds)
            if (i < total - 1) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        displayResults(allResults);

    } catch (error) {
        console.error('Error during search:', error);
        alert('An error occurred while connecting to BGG. Their servers may be heavily loaded right now. Please try again shortly.');
    } finally {
        toggleLoading(false);
    }
}

async function fetchWishlist(username) {
    const url = `${BGG_API_BASE}/collection?username=${username}&wishlist=1`;
    const proxyUrl = `${CORS_PROXY}${encodeURIComponent(url)}`;
    
    let response = await fetch(proxyUrl);
    let retries = 0;
    
    // BGG returns 202 while it generates the collection on their server
    while (retries < 6) {
        if (response.status === 202 || response.status === 503) {
            retries++;
            updateLoadingText(`BGG is preparing your collection (Attempt ${retries}/6)...`);
            await new Promise(resolve => setTimeout(resolve, 4000));
            response = await fetch(proxyUrl);
        } else {
            break;
        }
    }

    if (!response.ok) {
        throw new Error(`Failed to fetch wishlist: ${response.status}`);
    }

    const xmlText = await response.text();
    
    // If the response text is empty or an error message block
    if (!xmlText || xmlText.includes('<error>')) {
        return [];
    }

    const json = xmlToJson(xmlText);
    const items = json.items?.item || [];
    const wishlistArray = Array.isArray(items) ? items : [items];
    
    if (wishlistArray.length === 0 || !wishlistArray[0]['@_objectid']) {
        return [];
    }

    return wishlistArray.map(item => ({
        id: item['@_objectid'],
        name: item.name && item.name['#text'] ? item.name['#text'] : (item.name || 'Unknown Game'),
        thumbnail: item.thumbnail || ''
    }));
}

async function fetchTrades(gameId, countryFilter) {
    const url = `${GEEKDO_API_BASE}/collections?objectid=${gameId}&objecttype=thing&fortrade=1`;
    const proxyUrl = `${CORS_PROXY}${encodeURIComponent(url)}`;
    
    try {
        const response = await fetch(proxyUrl);
        if (!response.ok) return [];
        const text = await response.text();
        if (!text.startsWith('{')) return []; // Handle proxy or HTML error pages gracefully
        
        const data = JSON.parse(text);
        const trades = [];
        if (data.items) {
            data.items.forEach(item => {
                const user = item.user;
                if (user && user.country && user.country.toLowerCase().includes(countryFilter)) {
                    trades.push({ username: user.username });
                }
            });
        }
        return trades;
    } catch (e) {
        console.warn(`Could not fetch trades for game ID ${gameId}`);
        return [];
    }
}

async function fetchSales(gameId, countryFilter) {
    const url = `${GEEKDO_API_BASE}/market/products?objectid=${gameId}&objecttype=thing&stock=instock`;
    const proxyUrl = `${CORS_PROXY}${encodeURIComponent(url)}`;
    
    try {
        const response = await fetch(proxyUrl);
        if (!response.ok) return [];
        const text = await response.text();
        if (!text.startsWith('{')) return [];

        const data = JSON.parse(text);
        const sales = [];
        if (data.items) {
            data.items.forEach(item => {
                const user = item.user;
                if (user && user.country && user.country.toLowerCase().includes(countryFilter)) {
                    sales.push({
                        username: user.username,
                        price: item.price ? `${item.price.currency} ${item.price.value}` : 'Price N/A',
                        marketId: item.id
                    });
                }
            });
        }
        return sales;
    } catch (e) {
        console.warn(`Could not fetch sales for game ID ${gameId}`);
        return [];
    }
}

function xmlToJson(xmlString) {
    const parser = new DOMParser();
    const xml = parser.parseFromString(xmlString, "text/xml");
    
    function parseNode(node) {
        const obj = {};
        if (node.nodeType === 1) { 
            if (node.attributes.length > 0) {
                for (let j = 0; j < node.attributes.length; j++) {
                    const attribute = node.attributes.item(j);
                    obj[`@_${attribute.nodeName}`] = attribute.nodeValue;
                }
            }
        } else if (node.nodeType === 3) { 
            return node.nodeValue.trim();
        }
        if (node.hasChildNodes()) {
            for (let i = 0; i < node.childNodes.length; i++) {
                const item = node.childNodes.item(i);
                const nodeName = item.nodeName;
                if (nodeName === '#text') {
                    const text = item.nodeValue.trim();
                    if (text) {
                        obj['#text'] = text;
                    }
                } else {
                    const childObj = parseNode(item);
                    if (obj[nodeName] === undefined) {
                        obj[nodeName] = childObj;
                    } else {
                        if (!Array.isArray(obj[nodeName])) {
                            obj[nodeName] = [obj[nodeName]];
                        }
                        obj[nodeName].push(childObj);
                    }
                }
            }
        }
        if (Object.keys(obj).length === 1 && obj['#text']) {
            return obj['#text'];
        }
        return obj;
    }
    return parseNode(xml.documentElement);
}

function displayResults(results) {
    const grid = document.getElementById('results-grid');
    grid.innerHTML = '';

    if (results.length === 0) {
        grid.innerHTML = '<p>No local matches found for your wishlist.</p>';
        return;
    }

    results.forEach(res => {
        const card = document.createElement('div');
        card.className = 'card';

        const priceHtml = res.type === 'Sale' ? `<p class="card-detail"><strong>Price:</strong> ${res.price}</p>` : '';
        const badgeClass = res.type === 'Sale' ? 'sale' : 'trade';

        card.innerHTML = `
            <div class="card-img" style="background-image: url('${res.thumbnail}')"></div>
            <div class="card-content">
                <span class="badge ${badgeClass}">${res.type}</span>
                <h3 class="card-title">${res.gameName}</h3>
                <p class="card-detail"><strong>User:</strong> ${res.username}</p>
                ${priceHtml}
                <a href="${res.link}" target="_blank" class="card-link">View ${res.type === 'Sale' ? 'Listing' : 'Profile'}</a>
            </div>
        `;
        grid.appendChild(card);
    });
}

function toggleLoading(show, text = '') {
    const indicator = document.getElementById('loading-indicator');
    const textEl = document.getElementById('loading-text');
    if (show) {
        indicator.classList.remove('hidden');
        textEl.textContent = text;
    } else {
        indicator.classList.add('hidden');
    }
}

function updateLoadingText(text) {
    document.getElementById('loading-text').textContent = text;
}

function clearResults() {
    document.getElementById('results-grid').innerHTML = '';
}
