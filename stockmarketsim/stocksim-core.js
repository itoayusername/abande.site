// StockSim Shared Game Engine & Core Logic (Firebase Integrated)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, doc, setDoc, getDoc, onSnapshot, collection, addDoc, query, orderBy, limit, getDocs } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyC5f9Lq31IhRdqiJ26SLbxPGbiHMlCfJHg",
  authDomain: "games-f7131.firebaseapp.com",
  projectId: "games-f7131",
  storageBucket: "games-f7131.firebasestorage.app",
  messagingSenderId: "963842663388",
  appId: "1:963842663388:web:4ce1bfc218f23e26d4e519"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

function generateWalletId() {
    let wid = localStorage.getItem('stocksim_wallet_id');
    if (!wid) {
        wid = 'WAL-' + Math.floor(100000 + Math.random() * 900000);
        localStorage.setItem('stocksim_wallet_id', wid);
    }
    return wid;
}

window.gameState = {
    uid: localStorage.getItem('stocksim_uid') || 'user_' + Math.random().toString(36).substring(2, 9),
    username: localStorage.getItem('stocksim_user') || 'Trader_Pro',
    walletId: generateWalletId(),
    cash: parseFloat(localStorage.getItem('stocksim_cash')) || 100.00,
    portfolio: JSON.parse(localStorage.getItem('stocksim_portfolio') || '{}'),
    history: JSON.parse(localStorage.getItem('stocksim_history') || '[]'),
    totalGained: 0,
    totalLoss: 0,
    totalTaxPaid: 0
};

localStorage.setItem('stocksim_uid', window.gameState.uid);

window.currentNews = "Markets open stable. Technology and retail sectors show early momentum.";
let simulationInterval = null;

// Initialize or retrieve absolute target timestamps to prevent tab-switching resets
const TICK_INTERVAL_SEC = 10;
const NEWS_INTERVAL_SEC = 300;

function getStoredTimestamp(key, intervalSec) {
    let target = parseInt(localStorage.getItem(key), 10);
    const now = Date.now();
    if (!target || target <= now || target > now + intervalSec * 1000) {
        target = now + intervalSec * 1000;
        localStorage.setItem(key, target);
    }
    return target;
}

let nextPriceTickTime = getStoredTimestamp('stocksim_next_tick', TICK_INTERVAL_SEC);
let nextNewsTickTime = getStoredTimestamp('stocksim_next_news', NEWS_INTERVAL_SEC);

window.stocks = [
    { ticker: 'AAPL', name: 'Apple Inc.', category: 'Technology', taxRate: 0.14, price: 172.40, history: [178, 175, 174, 172.4] },
    { ticker: 'MSFT', name: 'Microsoft Corp.', category: 'Technology', taxRate: 0.15, price: 405.10, history: [415, 412, 408, 405.1] },
    { ticker: 'GOOGL', name: 'Alphabet Inc.', category: 'Technology', taxRate: 0.14, price: 137.90, history: [142, 140, 139, 137.9] },
    { ticker: 'AMZN', name: 'Amazon.com Inc.', category: 'Consumer Cyclical', taxRate: 0.12, price: 174.50, history: [180, 178, 176, 174.5] },
    { ticker: 'TSLA', name: 'Tesla Inc.', category: 'Automotive', taxRate: 0.18, price: 188.20, history: [198, 195, 191, 188.2] },
    { ticker: 'META', name: 'Meta Platforms', category: 'Technology', taxRate: 0.15, price: 472.00, history: [485, 480, 478, 472] },
    { ticker: 'NVDA', name: 'NVIDIA Corp.', category: 'Semiconductors', taxRate: 0.16, price: 860.00, history: [880, 875, 868, 860] },
    { ticker: 'NFLX', name: 'Netflix Inc.', category: 'Communication', taxRate: 0.13, price: 598.40, history: [615, 608, 602, 598.4] },
    { ticker: 'DIS', name: 'Walt Disney Co.', category: 'Entertainment', taxRate: 0.11, price: 109.20, history: [113, 112, 110.5, 109.2] },
    { ticker: 'JPM', name: 'JPMorgan Chase', category: 'Financial', taxRate: 0.20, price: 194.50, history: [200, 198, 196, 194.5] },
    { ticker: 'V', name: 'Visa Inc.', category: 'Financial', taxRate: 0.18, price: 274.30, history: [280, 278, 276, 274.3] },
    { ticker: 'JNJ', name: 'Johnson & Johnson', category: 'Healthcare', taxRate: 0.10, price: 153.20, history: [157, 155.8, 154.5, 153.2] },
    { ticker: 'WMT', name: 'Walmart Inc.', category: 'Retail', taxRate: 0.09, price: 58.90, history: [61, 60.2, 59.5, 58.9] },
    { ticker: 'PG', name: 'Procter & Gamble', category: 'Consumer Defensive', taxRate: 0.09, price: 159.10, history: [163, 161.5, 160.2, 159.1] },
    { ticker: 'MA', name: 'Mastercard Inc.', category: 'Financial', taxRate: 0.18, price: 448.20, history: [460, 455, 451, 448.2] },
    { ticker: 'UNH', name: 'UnitedHealth Group', category: 'Healthcare', taxRate: 0.10, price: 485.00, history: [498, 492, 488, 485] },
    { ticker: 'HD', name: 'Home Depot', category: 'Retail', taxRate: 0.11, price: 360.10, history: [372, 368, 364, 360.1] },
    { ticker: 'BAC', name: 'Bank of America', category: 'Financial', taxRate: 0.17, price: 36.50, history: [38.2, 37.5, 37.0, 36.5] },
    { ticker: 'XOM', name: 'Exxon Mobil', category: 'Energy', taxRate: 0.22, price: 112.30, history: [116, 114.5, 113.4, 112.3] },
    { ticker: 'INTC', name: 'Intel Corp.', category: 'Semiconductors', taxRate: 0.12, price: 29.10, history: [31.5, 30.6, 29.8, 29.1] },
    { ticker: 'AMD', name: 'Advanced Micro Devices', category: 'Semiconductors', taxRate: 0.15, price: 171.40, history: [182, 178, 175, 171.4] },
    { ticker: 'IBM', name: 'IBM Corp.', category: 'Technology', taxRate: 0.13, price: 186.50, history: [192, 190, 188.2, 186.5] },
    { ticker: 'PYPL', name: 'PayPal Holdings', category: 'Financial', taxRate: 0.16, price: 61.80, history: [65, 63.5, 62.4, 61.8] },
    { ticker: 'ADBE', name: 'Adobe Inc.', category: 'Technology', taxRate: 0.15, price: 478.20, history: [495, 488, 483, 478.2] },
    { ticker: 'BTC', name: 'Bitcoin Strategy', category: 'Crypto', taxRate: 0.25, price: 62000.00, history: [66000, 64500, 63200, 62000] },
    { ticker: 'NKE', name: 'Nike Inc.', category: 'Consumer Cyclical', taxRate: 0.10, price: 44.50, history: [46, 45.2, 44.8, 44.5] },
    { ticker: 'F', name: 'Ford Motor Co.', category: 'Automotive', taxRate: 0.14, price: 11.20, history: [11.8, 11.5, 11.3, 11.2] },
    { ticker: 'PFE', name: 'Pfizer Inc.', category: 'Healthcare', taxRate: 0.10, price: 27.80, history: [28.5, 28.2, 27.9, 27.8] },
    { ticker: 'SNAP', name: 'Snap Inc.', category: 'Communication', taxRate: 0.12, price: 12.40, history: [13.1, 12.8, 12.6, 12.4] },
    { ticker: 'U', name: 'Unity Software', category: 'Technology', taxRate: 0.14, price: 18.90, history: [20.2, 19.5, 19.1, 18.9] },
    { ticker: 'PLTR', name: 'Palantir Technologies', category: 'Technology', taxRate: 0.15, price: 38.60, history: [36.5, 37.2, 38.0, 38.6] },
    { ticker: 'COIN', name: 'Coinbase Global', category: 'Crypto / FinTech', taxRate: 0.24, price: 49.80, history: [52, 51.1, 50.4, 49.8] },
    { ticker: 'SOFI', name: 'SoFi Technologies', category: 'Financial', taxRate: 0.16, price: 7.90, history: [8.2, 8.1, 8.0, 7.9] },
    { ticker: 'NIO', name: 'NIO Inc.', category: 'Automotive', taxRate: 0.17, price: 5.40, history: [5.8, 5.7, 5.5, 5.4] },
    { ticker: 'AAL', name: 'American Airlines', category: 'Travel', taxRate: 0.13, price: 14.30, history: [15.0, 14.8, 14.5, 14.3] },
    { ticker: 'CCL', name: 'Carnival Corp.', category: 'Travel', taxRate: 0.13, price: 16.70, history: [17.5, 17.2, 16.9, 16.7] },
    { ticker: 'VALE', name: 'Vale S.A.', category: 'Materials', taxRate: 0.19, price: 10.80, history: [11.2, 11.0, 10.9, 10.8] },
    { ticker: 'ABNB', name: 'Airbnb Inc.', category: 'Travel', taxRate: 0.15, price: 48.20, history: [50.1, 49.5, 48.8, 48.2] },
    { ticker: 'HOOD', name: 'Robinhood Markets', category: 'Financial', taxRate: 0.18, price: 22.40, history: [21.5, 21.8, 22.1, 22.4] },
    { ticker: 'RBLX', name: 'Roblox Corp.', category: 'Entertainment', taxRate: 0.12, price: 41.50, history: [43.0, 42.4, 41.9, 41.5] },
    { ticker: 'PINS', name: 'Pinterest Inc.', category: 'Communication', taxRate: 0.12, price: 33.20, history: [34.5, 34.0, 33.6, 33.2] },
    { ticker: 'UBER', name: 'Uber Technologies', category: 'Technology', taxRate: 0.15, price: 46.90, history: [48.0, 47.5, 47.2, 46.9] },
    { ticker: 'RIVN', name: 'Rivian Automotive', category: 'Automotive', taxRate: 0.18, price: 13.50, history: [14.2, 13.9, 13.7, 13.5] },
    { ticker: 'LCID', name: 'Lucid Group', category: 'Automotive', taxRate: 0.19, price: 3.20, history: [3.5, 3.4, 3.3, 3.2] },
    { ticker: 'PLUG', name: 'Plug Power', category: 'Energy', taxRate: 0.20, price: 2.40, history: [2.7, 2.6, 2.5, 2.4] },
    { ticker: 'SIRI', name: 'Sirius XM Holdings', category: 'Communication', taxRate: 0.11, price: 4.10, history: [4.3, 4.2, 4.15, 4.1] },
    { ticker: 'KGC', name: 'Kinross Gold', category: 'Materials', taxRate: 0.18, price: 9.60, history: [9.2, 9.4, 9.5, 9.6] },
    { ticker: 'AUY', name: 'Yamana Gold / Peer', category: 'Materials', taxRate: 0.18, price: 6.80, history: [6.5, 6.6, 6.7, 6.8] },
    { ticker: 'NOK', name: 'Nokia Oyj', category: 'Technology', taxRate: 0.12, price: 4.50, history: [4.6, 4.55, 4.52, 4.5] },
    { ticker: 'ERIC', name: 'Telefonaktiebolaget LM Ericsson', category: 'Technology', taxRate: 0.12, price: 6.20, history: [6.4, 6.3, 6.25, 6.2] }
];

const newsPool = [
    { text: "Apple announces breakthrough holographic display headset, sending tech stocks soaring.", category: "Technology", effect: 0.08 },
    { text: "Federal Reserve unexpectedly hikes interest rates by 75 basis points to combat inflation.", category: "Financial", effect: -0.07 },
    { text: "Major oil pipeline disruption in the Middle East causes crude prices and energy stocks to spike.", category: "Energy", effect: 0.09 },
    { text: "Global semiconductor shortage intensifies as key fabrication plants face power grid failures.", category: "Semiconductors", effect: -0.08 },
    { text: "Bitcoin surges past major resistance levels following SEC spot ETF approval rumors.", category: "Crypto", effect: 0.12 },
    { text: "Supply chain bottlenecks at major ports delay consumer holiday shipments worldwide.", category: "Retail", effect: -0.06 },
    { text: "Tesla unveils revolutionary solid-state battery architecture with 1,000-mile range.", category: "Automotive", effect: 0.10 },
    { text: "Pfizer announces FDA fast-track designation for its novel oncology treatment pipeline.", category: "Healthcare", effect: 0.07 }
];

async function saveGame() {
    localStorage.setItem('stocksim_cash', window.gameState.cash);
    localStorage.setItem('stocksim_portfolio', JSON.stringify(window.gameState.portfolio));
    localStorage.setItem('stocksim_history', JSON.stringify(window.gameState.history));
    localStorage.setItem('stocksim_wallet_id', window.gameState.walletId);
    
    try {
        await setDoc(doc(db, "players", window.gameState.uid), {
            uid: window.gameState.uid,
            username: window.gameState.username,
            walletId: window.gameState.walletId,
            cash: window.gameState.cash,
            portfolio: window.gameState.portfolio,
            netWorth: calculateNetWorth(),
            totalTaxPaid: window.gameState.totalTaxPaid || 0,
            lastUpdated: new Date()
        }, { merge: true });
    } catch (e) {
        console.error("Firebase sync error: ", e);
    }
}

window.saveGameToFirebase = saveGame;

async function loadGame() {
    window.gameState.cash = parseFloat(localStorage.getItem('stocksim_cash')) || 100.00;
    window.gameState.walletId = localStorage.getItem('stocksim_wallet_id') || generateWalletId();
    try {
        const port = localStorage.getItem('stocksim_portfolio');
        if (port) window.gameState.portfolio = JSON.parse(port);
        const hist = localStorage.getItem('stocksim_history');
        if (hist) window.gameState.history = JSON.parse(hist);

        if (window.gameState.uid) {
            const docRef = doc(db, "players", window.gameState.uid);
            const docSnap = await getDoc(docRef);
            if (docSnap.exists()) {
                const data = docSnap.data();
                if (data.walletId) {
                    window.gameState.walletId = data.walletId;
                    localStorage.setItem('stocksim_wallet_id', data.walletId);
                }
                if (data.cash !== undefined) {
                    window.gameState.cash = data.cash;
                    localStorage.setItem('stocksim_cash', data.cash);
                }
                if (data.portfolio) {
                    window.gameState.portfolio = data.portfolio;
                    localStorage.setItem('stocksim_portfolio', JSON.stringify(data.portfolio));
                }
            }
        }
    } catch (e) {
        console.error("Load state error: ", e);
    }
}

function calculateNetWorth() {
    let total = window.gameState.cash;
    Object.keys(window.gameState.portfolio).forEach(ticker => {
        const holding = window.gameState.portfolio[ticker];
        const stock = window.stocks.find(s => s.ticker === ticker);
        if (stock && holding) {
            total += holding.shares * stock.price;
        }
    });
    return total;
}

window.updateStatsBar = function() {
    const cashEl = document.getElementById('cash-display');
    const networthEl = document.getElementById('networth-display');
    const walletEl = document.getElementById('header-wallet-id');
    const netWorth = calculateNetWorth();

    if (cashEl) cashEl.innerText = `$${window.gameState.cash.toFixed(2)}`;
    if (networthEl) networthEl.innerText = `$${netWorth.toFixed(2)}`;
    if (walletEl) walletEl.innerText = window.gameState.walletId;
}

function tickSimulator() {
    const now = Date.now();

    // Check Price Tick Countdown based on real timestamp
    if (now >= nextPriceTickTime) {
        nextPriceTickTime = now + TICK_INTERVAL_SEC * 1000;
        localStorage.setItem('stocksim_next_tick', nextPriceTickTime);

        window.stocks.forEach(stock => {
            const pct = (Math.random() * 0.06 - 0.028);
            stock.price = Math.max(0.5, stock.price * (1 + pct));
            if (!stock.history) stock.history = [];
            stock.history.push(parseFloat(stock.price.toFixed(2)));
            if (stock.history.length > 20) stock.history.shift();
        });
        window.updateStatsBar();
        if (typeof renderPage === 'function') renderPage();
    }

    // Check News Dispatch Countdown based on real timestamp
    if (now >= nextNewsTickTime) {
        nextNewsTickTime = now + NEWS_INTERVAL_SEC * 1000;
        localStorage.setItem('stocksim_next_news', nextNewsTickTime);
        triggerNewDispatch();
    }

    // Calculate remaining seconds for UI badges
    const priceSecondsLeft = Math.max(0, Math.ceil((nextPriceTickTime - now) / 1000));
    const newsSecondsLeft = Math.max(0, Math.ceil((nextNewsTickTime - now) / 1000));

    const timerBadge = document.getElementById('timer-badge');
    if (timerBadge) timerBadge.innerText = `${priceSecondsLeft}s`;

    const newsTimerBadge = document.getElementById('news-timer-badge');
    const bigCountdown = document.getElementById('big-countdown');
    const mins = Math.floor(newsSecondsLeft / 60);
    const secs = newsSecondsLeft % 60;
    const timeStr = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
    if (newsTimerBadge) newsTimerBadge.innerText = timeStr;
    if (bigCountdown) bigCountdown.innerText = timeStr;
}

function triggerNewDispatch() {
    const randNews = newsPool[Math.floor(Math.random() * newsPool.length)];
    window.currentNews = randNews.text;
    
    window.stocks.forEach(stock => {
        if (stock.category === randNews.category) {
            stock.price = Math.max(1, stock.price * (1 + randNews.effect));
        }
    });

    const tickerText = document.getElementById('news-ticker-text');
    if (tickerText) tickerText.innerText = window.currentNews;
}

window.getPlayerRankings = function() {
    const netWorth = calculateNetWorth();
    const userEntry = {
        name: window.gameState.username,
        walletId: window.gameState.walletId,
        netWorth: netWorth,
        earnings: netWorth - 100,
        loss: netWorth < 100 ? 100 - netWorth : 0,
        taxPaid: window.gameState.totalTaxPaid || 0,
        isUser: true
    };

    const simulatedPlayers = [
        userEntry,
        { name: "CryptoWhale99", walletId: "WAL-998231", netWorth: 410.50, earnings: 310.50, loss: 0, taxPaid: 45.00 },
        { name: "BullishBella", walletId: "WAL-882391", netWorth: 285.20, earnings: 185.20, loss: 0, taxPaid: 22.50 },
        { name: "WallStreetWolf", walletId: "WAL-442109", netWorth: 78.40, earnings: 0, loss: 21.60, taxPaid: 5.00 },
        { name: "DiamondHands", walletId: "WAL-110923", netWorth: 520.00, earnings: 420.00, loss: 0, taxPaid: 88.20 }
    ];

    simulatedPlayers.sort((a, b) => b.netWorth - a.netWorth);

    return {
        mostGained: [...simulatedPlayers].sort((a, b) => b.earnings - a.earnings),
        mostLoss: [...simulatedPlayers].sort((a, b) => b.loss - a.loss),
        mostTaxed: [...simulatedPlayers].sort((a, b) => b.taxPaid - a.taxPaid),
        simulatedPlayers
    };
}

window.initSimulator = async function(callback) {
    await loadGame();
    if (typeof callback === 'function') callback();
    if (!simulationInterval) {
        simulationInterval = setInterval(tickSimulator, 1000);
    }
}