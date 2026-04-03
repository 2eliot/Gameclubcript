const express = require('express');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const fs = require('fs');
const path = require('path');

chromium.use(stealth);

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 5005);
const MAX_CONCURRENCIA = 2;
let tareasActivas = 0;
const colaEspera = [];

const CONFIG = {
    email: process.env.GAME_EMAIL || '',
    pass: process.env.GAME_PASSWORD || '',
    pin: process.env.GAME_PIN || ''
};

// Paquetes disponibles
const PAQUETES = {
    '50_gold': { goodsid: 'g83naxx1ena.USD.gold50.ally', goodsinfo: '50 barras de oro', selector: 'text=50' },
    '100_gold': { goodsid: 'g83naxx1ena.USD.gold100.ally', goodsinfo: '100 barras de oro', selector: 'text=100' },
    '300_gold': { goodsid: 'g83naxx1ena.USD.gold300.ally', goodsinfo: '300 barras de oro', selector: 'text=300' },
    '500_gold': { goodsid: 'g83naxx1ena.USD.gold500.ally', goodsinfo: '500 barras de oro', selector: 'text=500' },
    '1000_gold': { goodsid: 'g83naxx1ena.USD.gold1000.ally', goodsinfo: '1000 barras de oro', selector: 'text=1000' }
};

const COOKIES_FILE = path.join(__dirname, 'cookies.json');
const STORE_URL = 'https://pay.neteasegames.com/BloodStrike/topup?from=home&region=BD&lang=es';
const PRODUCT_ENDPOINT = '/gameclub/products/bloodstrike';
const ANALYTICS_PATTERNS = [
    'google-analytics.com',
    'googletagmanager.com',
    'doubleclick.net',
    'facebook.net',
    'facebook.com',
    'connect.facebook.net',
    'googleadservices.com',
    'sensorsdata'
];

async function guardarCookies(context) {
    const state = await context.storageState();
    fs.writeFileSync(COOKIES_FILE, JSON.stringify(state, null, 2));
}

function cargarCookies() {
    if (fs.existsSync(COOKIES_FILE)) {
        return JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
    }
    return null;
}

function isFirstPartyHost(hostname = '') {
    return hostname === 'pay.neteasegames.com' ||
        hostname.endsWith('.neteasegames.com') ||
        hostname.endsWith('.163.com') ||
        hostname.endsWith('.126.net');
}

function validarConfiguracionBase() {
    const faltantes = [];

    if (!CONFIG.email) {
        faltantes.push('GAME_EMAIL');
    }

    if (!CONFIG.pass) {
        faltantes.push('GAME_PASSWORD');
    }

    if (!CONFIG.pin) {
        faltantes.push('GAME_PIN');
    }

    if (faltantes.length > 0) {
        throw new Error(`Faltan variables de entorno requeridas: ${faltantes.join(', ')}`);
    }
}

function shouldAbortRequest(request) {
    const url = request.url();
    const resourceType = request.resourceType();
    const lowerUrl = url.toLowerCase();

    let hostname = '';
    let pathname = '';
    try {
        const parsedUrl = new URL(url);
        hostname = parsedUrl.hostname;
        pathname = parsedUrl.pathname.toLowerCase();
    } catch (error) {
        pathname = lowerUrl;
    }

    if (resourceType === 'font' || resourceType === 'media') {
        return true;
    }

    if (/\.(woff2?|ttf|otf|eot)(\?|$)/.test(pathname)) {
        return true;
    }

    if (ANALYTICS_PATTERNS.some(pattern => lowerUrl.includes(pattern))) {
        return true;
    }

    if ((resourceType === 'image' || /\.(png|jpe?g|webp|gif|svg|ico)(\?|$)/.test(pathname)) && !isFirstPartyHost(hostname)) {
        return true;
    }

    return false;
}

async function applyPrewarm(context) {
    await context.addInitScript(() => {
        const selectedRegion = {
            region: 'Bangladesh',
            regionCode: 'BD',
            language: 'es',
            languageName: 'español'
        };

        const entries = [
            ['region', 'BD'],
            ['language', 'es'],
            ['lang', 'es'],
            ['locale', 'es']
        ];

        for (const [key, value] of entries) {
            window.localStorage.setItem(key, value);
            window.sessionStorage.setItem(key, value);
        }

        const serializedRegion = JSON.stringify(selectedRegion);
        window.localStorage.setItem('selectedRegion', serializedRegion);
        window.sessionStorage.setItem('selectedRegion', serializedRegion);
    });
}

function waitForProductsResponse(page, timeout = 15000) {
    return page.waitForResponse(response => {
        const url = response.url();
        const contentType = response.headers()['content-type'] || '';

        return url.includes(PRODUCT_ENDPOINT) &&
            !url.includes('pay_type_route') &&
            response.ok() &&
            contentType.includes('application/json');
    }, { timeout });
}

async function ingresarRoleIdYEsperarProductos(page, roleId) {
    const inputSelector = 'input[placeholder*="ID de personaje"], input[placeholder*="Character ID"], input[placeholder*="ID"], input[type="text"]';

    for (let intento = 1; intento <= 2; intento++) {
        try {
            const inputPersonaje = page.locator(inputSelector).first();
            await inputPersonaje.waitFor({ state: 'visible', timeout: 5000 });
            await inputPersonaje.fill(roleId);

            const checkbox = page.locator('input[type="checkbox"], .checkbox, .adm-checkbox-icon').first();
            if (await checkbox.isVisible({ timeout: 1000 }).catch(() => false)) {
                const checkboxChecked = await checkbox.isChecked().catch(() => false);
                if (!checkboxChecked) {
                    await checkbox.click();
                }
            }

            const productosPromise = waitForProductsResponse(page, 15000);
            const loginBtn = page.locator('.userid-login-btn').first();
            await loginBtn.waitFor({ state: 'visible', timeout: 5000 });
            await loginBtn.click();
            await productosPromise;
            return;
        } catch (error) {
            if (intento === 2) {
                throw new Error(`No fue posible ingresar el ID del personaje: ${error.message}`);
            }

            await page.goto(STORE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await page.waitForSelector('.region-name, .userid-login-btn, input[type="text"]', { state: 'visible', timeout: 15000 });
        }
    }
}

async function seleccionarPaquete(page, paquete) {
    const selectors = [
        `[data-goodsid="${paquete.goodsid}"]`,
        `[data-goods-id="${paquete.goodsid}"]`,
        `text=${paquete.goodsinfo}`,
        paquete.selector,
        `.goods-item:has-text("${paquete.goodsinfo.split(' ')[0]}")`
    ];

    for (const selector of selectors) {
        const option = page.locator(selector).first();
        if (await option.isVisible({ timeout: 1200 }).catch(() => false)) {
            await option.click();
            return;
        }
    }

    throw new Error(`No se encontró el paquete ${paquete.goodsinfo}`);
}

async function asegurarSesionWeb(page) {
    const necesitaLogin = await page.locator('.wallet-entry').isVisible().catch(() => false);
    if (!necesitaLogin) {
        return;
    }

    const [loginPage] = await Promise.all([
        context.waitForEvent('page'),
        page.click('.wallet-entry')
    ]);

    await loginPage.waitForLoadState('domcontentloaded');
    await loginPage.waitForSelector('input[name="account"]', { state: 'visible', timeout: 30000 });
    await loginPage.fill('input[name="account"]', CONFIG.email);
    await loginPage.fill('input[name="hash_password"]', CONFIG.pass);
    await loginPage.click('.login-in-button');
    await page.waitForSelector('.region-name, .userid-login-btn, input[type="text"]', { state: 'visible', timeout: 90000 });
    await guardarCookies(context);
}

async function extraerPaquetesVisibles(page) {
    return page.locator('.goods-item, [data-goodsid], [data-goods-id]').evaluateAll(elements => {
        const seen = new Set();

        return elements.map(element => {
            const goodsId = element.getAttribute('data-goodsid') || element.getAttribute('data-goods-id') || '';
            const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
            const lines = text.split(/(?<=\D)\s+(?=\D)|\n/).map(value => value.trim()).filter(Boolean);
            const title = lines.find(value => /gold|oro|bars|barras|pass|chest|skin/i.test(value)) || lines[0] || text;
            const priceMatch = text.match(/BDT\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
            const price = priceMatch ? `BDT ${priceMatch[1]}` : null;
            const normalizedKey = `${goodsId}::${title}::${price || ''}`;

            if (!title || seen.has(normalizedKey)) {
                return null;
            }

            seen.add(normalizedKey);
            return {
                goodsid: goodsId || null,
                title,
                price,
                rawText: text
            };
        }).filter(Boolean);
    });
}

async function mapearPaquetes(roleId) {
    validarConfiguracionBase();
    await iniciarNavegador();
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(45000);

    try {
        await page.route('**/*', route => {
            if (shouldAbortRequest(route.request())) {
                return route.abort();
            }

            return route.continue();
        });

        await page.goto(STORE_URL, { waitUntil: 'commit', timeout: 45000 });
        await page.waitForSelector('.wallet-entry, .region-name, .userid-login-btn, input[type="text"]', { state: 'visible', timeout: 15000 });
        await asegurarSesionWeb(page);

        const currentRegion = await page.locator('.region-name').textContent().catch(() => '');
        if (!currentRegion.includes('Bangladesh')) {
            await page.goto(STORE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await page.waitForSelector('.region-name, .userid-login-btn, input[type="text"]', { state: 'visible', timeout: 15000 });
        }

        if (roleId) {
            await ingresarRoleIdYEsperarProductos(page, roleId);
        } else {
            await page.waitForSelector('.goods-item, [data-goodsid], [data-goods-id], .userid-login-btn', { state: 'visible', timeout: 15000 });
        }

        const paquetes = await extraerPaquetesVisibles(page);

        return {
            success: true,
            roleId: roleId || null,
            total: paquetes.length,
            paquetes,
            fetchedAt: new Date().toISOString()
        };
    } catch (error) {
        return {
            success: false,
            roleId: roleId || null,
            total: 0,
            paquetes: [],
            fetchedAt: new Date().toISOString(),
            error: error.message
        };
    } finally {
        await page.close().catch(() => {});
    }
}

// Variable global para el navegador (mantener sesión)
let browser = null;
let context = null;

async function iniciarNavegador() {
    if (!browser) {
        validarConfiguracionBase();
        console.log("🚀 Iniciando navegador en modo headless...");
        browser = await chromium.launch({ 
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-gpu',
                '--disable-dev-shm-usage',
                '--ignore-certificate-errors'
            ]
        });
        
        const cookiesData = cargarCookies();
        const contextOptions = {
            viewport: { width: 390, height: 844 },
            userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1',
            isMobile: true,
            hasTouch: true,
            ignoreHTTPSErrors: true
        };
        
        if (cookiesData) {
            contextOptions.storageState = cookiesData;
        }
        
        context = await browser.newContext(contextOptions);
        await applyPrewarm(context);
        console.log("✅ Navegador listo");
    }
    return { browser, context };
}

async function ejecutarCompra(roleId, paqueteKey) {
    const tiempoInicio = Date.now();
    let nombreJugador = '';
    let ordenId = '';
    let precioComprado = '';
    let error = null;
    
    const paquete = PAQUETES[paqueteKey] || PAQUETES['50_gold'];
    
    try {
        validarConfiguracionBase();
        await iniciarNavegador();
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        page.setDefaultNavigationTimeout(45000);
        
        // Mantener CSS pero bloquear recursos caros o irrelevantes.
        await page.route('**/*', route => {
            if (shouldAbortRequest(route.request())) {
                return route.abort();
            }
            return route.continue();
        });

        console.log(`   🌐 [${roleId}] Navegando a la tienda`);

        // Capturar datos de respuestas
        page.on('response', async response => {
            const url = response.url();
            try {
                if (url.includes('login-role')) {
                    const json = await response.json();
                    if (json.data?.rolename) nombreJugador = json.data.rolename;
                }
                if (url.includes('/gameclub/products/bloodstrike') && !url.includes('pay_type_route')) {
                    const json = await response.json();
                    if (json.data?.sn) ordenId = json.data.sn;
                    if (json.data?.order_price) precioComprado = json.data.order_price + ' BDT';
                }
            } catch (e) {}
        });

        // Navegar
        await page.goto(STORE_URL, { waitUntil: 'commit', timeout: 45000 });
        await page.waitForSelector('.wallet-entry, .region-name, .userid-login-btn, input[type="text"]', { state: 'visible', timeout: 15000 });
        
        // Login si es necesario
        const necesitaLogin = await page.locator('.wallet-entry').isVisible().catch(() => false);
        console.log(`   🔐 [${roleId}] Login requerido: ${necesitaLogin ? 'sí' : 'no'}`);
        if (necesitaLogin) {
            const [loginPage] = await Promise.all([
                context.waitForEvent('page'),
                page.click('.wallet-entry')
            ]);
            
            await loginPage.waitForLoadState('domcontentloaded');
            await loginPage.waitForSelector('input[name="account"]', { state: 'visible', timeout: 30000 });
            await loginPage.fill('input[name="account"]', CONFIG.email);
            await loginPage.fill('input[name="hash_password"]', CONFIG.pass);
            await loginPage.click('.login-in-button');
            
            console.log(`   ⏳ [${roleId}] Esperando retorno del login/captcha`);
            await page.waitForSelector('.region-name, .userid-login-btn, input[type="text"]', { state: 'visible', timeout: 90000 });
            await guardarCookies(context);
        }

        const currentRegion = await page.locator('.region-name').textContent().catch(() => '');
        console.log(`   🌍 [${roleId}] Región detectada: ${currentRegion || 'no visible'}`);
        if (!currentRegion.includes('Bangladesh')) {
            await page.goto(STORE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await page.waitForSelector('.region-name, .userid-login-btn, input[type="text"]', { state: 'visible', timeout: 15000 });
        }

        // Ingresar ID de personaje
        console.log(`   🎮 [${roleId}] Enviando roleId y esperando productos`);
        await ingresarRoleIdYEsperarProductos(page, roleId);

        // Seleccionar paquete
        console.log(`   🛒 [${roleId}] Seleccionando paquete ${paquete.goodsinfo}`);
        await page.waitForSelector('.goods-item, [data-goodsid], [data-goods-id]', { state: 'visible', timeout: 10000 });
        await seleccionarPaquete(page, paquete);
        
        // Abrir carrito
        const carrito = page.locator('#sidebarCart, .sidebar-cart').first();
        if (await carrito.isVisible().catch(() => false)) {
            await carrito.click();
        }
        console.log(`   🧺 [${roleId}] Carrito abierto`);
        await page.waitForSelector('.gc-checkbox-mobile, .shopping-with-gift-cards .bui-checkbox', { state: 'visible', timeout: 10000 });
        
        // Activar NetEase Pay
        const netEasePayCheckbox = page.locator('.gc-checkbox-mobile, .shopping-with-gift-cards .bui-checkbox').first();
        if (await netEasePayCheckbox.isVisible({ timeout: 3000 })) {
            await netEasePayCheckbox.click();
        }
        console.log(`   💳 [${roleId}] Método de pago activado`);
        await page.waitForSelector('.cart-pay-btn, button:has-text("Top-up")', { state: 'visible', timeout: 10000 });
        
        // Top-up
        const topUpBtn = page.locator('.cart-pay-btn, button:has-text("Top-up")').first();
        if (await topUpBtn.isVisible({ timeout: 3000 })) {
            await topUpBtn.click();
        }
        console.log(`   🚀 [${roleId}] Top-up enviado, esperando PIN`);
        
        // PIN
        const pinInputs = page.locator('.pass-code-input');
        if (await pinInputs.first().isVisible({ timeout: 10000 })) {
            await pinInputs.first().click();
            for (const pinDigit of CONFIG.pin.split('')) {
                await page.keyboard.press(pinDigit, { delay: 50 });
            }

            const confirmBtn = page.locator('.action-btn.bui-button-primary, button:has-text("OK")').first();
            await confirmBtn.waitFor({ state: 'visible', timeout: 5000 });
            await confirmBtn.click();
            await pinInputs.first().waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
            console.log(`   ✅ [${roleId}] PIN enviado`);
        }
        
        await page.close();
        
    } catch (err) {
        error = err.message;
        console.log(`   ❌ [${roleId}] Error interno: ${error}`);
    }
    
    const tiempoFin = Date.now();
    const tiempoTotal = ((tiempoFin - tiempoInicio) / 1000).toFixed(2);
    
    return {
        success: !error,
        jugador: nombreJugador || null,
        roleId: roleId,
        paquete: paquete.goodsinfo,
        precio: precioComprado || null,
        orden: ordenId || null,
        tiempo: tiempoTotal + ' segundos',
        error: error
    };
}

// ============ ENDPOINTS ============

// Función para procesar la cola
async function procesarCola() {
    while (colaEspera.length > 0 && tareasActivas < MAX_CONCURRENCIA) {
        const siguiente = colaEspera.shift();
        if (siguiente) {
            siguiente();
        }
    }
}

// Endpoint para comprar
app.post('/comprar', async (req, res) => {
    const { roleId, paquete } = req.body;
    
    if (!roleId) {
        return res.status(400).json({ success: false, error: 'roleId es requerido' });
    }
    
    const paqueteKey = paquete || '50_gold';
    console.log(`\n📥 Nueva petición: roleId=${roleId}, paquete=${paqueteKey}`);
    console.log(`   ⏳ Cola: ${colaEspera.length} | Activas: ${tareasActivas}/${MAX_CONCURRENCIA}`);
    
    // Función que ejecuta la compra
    const ejecutar = async () => {
        tareasActivas++;
        console.log(`   🔄 Iniciando compra (${tareasActivas}/${MAX_CONCURRENCIA} activas)`);
        
        try {
            const resultado = await ejecutarCompra(roleId, paqueteKey);
            
            if (resultado.success) {
                console.log(`✅ Compra completada: ${resultado.jugador} - ${resultado.paquete}`);
            } else {
                console.log(`❌ Error: ${resultado.error}`);
            }
            
            res.json(resultado);
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        } finally {
            tareasActivas--;
            procesarCola();
        }
    };
    
    // Si hay espacio, ejecutar inmediatamente
    if (tareasActivas < MAX_CONCURRENCIA) {
        ejecutar();
    } else {
        // Agregar a la cola
        console.log(`   ⏸️ En cola de espera (posición ${colaEspera.length + 1})`);
        colaEspera.push(ejecutar);
    }
});

// Endpoint de estado
app.get('/status', (req, res) => {
    res.json({ 
        status: 'online',
        tareasActivas: tareasActivas,
        enCola: colaEspera.length,
        maxConcurrencia: MAX_CONCURRENCIA,
        paquetes_disponibles: Object.keys(PAQUETES)
    });
});

// Endpoint para listar paquetes
app.get('/paquetes', (req, res) => {
    res.json(PAQUETES);
});

// Endpoint para mapear los paquetes visibles bajo demanda
app.post('/mapear', async (req, res) => {
    const { roleId } = req.body || {};

    try {
        const resultado = await mapearPaquetes(roleId);
        if (!resultado.success) {
            return res.status(500).json(resultado);
        }

        return res.json(resultado);
    } catch (error) {
        return res.status(500).json({
            success: false,
            roleId: roleId || null,
            total: 0,
            paquetes: [],
            fetchedAt: new Date().toISOString(),
            error: error.message
        });
    }
});

// Iniciar servidor
app.listen(PORT, async () => {
    console.log("=".repeat(50));
    console.log(`🚀 Servidor de compras Blood Strike (PRODUCCIÓN)`);
    console.log(`📡 Escuchando en http://localhost:${PORT}`);
    console.log(`🔒 Modo: headless | Concurrencia: ${MAX_CONCURRENCIA}`);
    console.log("=".repeat(50));
    console.log(`\n📖 Endpoints disponibles:`);
    console.log(`   POST /comprar  - { roleId: "123", paquete: "50_gold" }`);
    console.log(`   GET  /status   - Estado del servidor`);
    console.log(`   GET  /paquetes - Lista de paquetes\n`);
    
    // Pre-iniciar navegador
    await iniciarNavegador();
});
