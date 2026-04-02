const express = require('express');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const fs = require('fs');
const path = require('path');

chromium.use(stealth);

const app = express();
app.use(express.json());

const PORT = 5005;
const MAX_CONCURRENCIA = 2;
let tareasActivas = 0;
const colaEspera = [];

const CONFIG = {
    email: "yorbitub@gmail.com",
    pass: "321Naruto%",
    pin: "276099"
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

// Variable global para el navegador (mantener sesión)
let browser = null;
let context = null;

async function iniciarNavegador() {
    if (!browser) {
        console.log("🚀 Iniciando navegador en modo headless...");
        browser = await chromium.launch({ 
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        
        const cookiesData = cargarCookies();
        const contextOptions = {
            viewport: { width: 390, height: 844 },
            userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1',
            isMobile: true,
            hasTouch: true
        };
        
        if (cookiesData) {
            contextOptions.storageState = cookiesData;
        }
        
        context = await browser.newContext(contextOptions);
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
        await iniciarNavegador();
        const page = await context.newPage();
        
        // Bloquear imágenes
        await page.route('**/*', route => {
            const resourceType = route.request().resourceType();
            if (['image', 'font', 'media'].includes(resourceType)) {
                return route.abort();
            }
            const url = route.request().url();
            if (url.includes('akamaized.net') || url.includes('imageView')) {
                return route.abort();
            }
            return route.continue();
        });

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
        await page.goto('https://pay.neteasegames.com/BloodStrike/topup?from=home', { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(1000);
        
        // Login si es necesario
        const necesitaLogin = await page.locator('.wallet-entry').isVisible();
        if (necesitaLogin) {
            const [loginPage] = await Promise.all([
                context.waitForEvent('page'),
                page.click('.wallet-entry')
            ]);
            
            await loginPage.waitForLoadState('networkidle');
            await loginPage.waitForSelector('input[name="account"]', { state: 'visible', timeout: 30000 });
            await loginPage.fill('input[name="account"]', CONFIG.email);
            await loginPage.fill('input[name="hash_password"]', CONFIG.pass);
            await loginPage.click('.login-in-button');
            
            await page.waitForSelector('.region-selector', { state: 'visible', timeout: 90000 });
            await guardarCookies(context);
        }

        // Configurar Bangladesh
        await page.waitForSelector('.region-selector', { state: 'visible', timeout: 15000 });
        await page.click('.region-selector');
        await page.waitForSelector('.adm-picker', { state: 'visible', timeout: 10000 });
        await page.waitForTimeout(300);
        await page.click('a.adm-picker-header-button:first-child');
        await page.waitForTimeout(200);
        
        await page.evaluate(() => {
            localStorage.setItem('region', 'BD');
            localStorage.setItem('language', 'es');
        });
        
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(1000);
        
        const currentRegion = await page.locator('.region-name').textContent().catch(() => '');
        if (!currentRegion.includes('Bangladesh')) {
            await page.goto('https://pay.neteasegames.com/BloodStrike/topup?from=home&region=BD&lang=es', { waitUntil: 'networkidle', timeout: 60000 });
            await page.waitForTimeout(1000);
        }

        // Ingresar ID de personaje
        const inputPersonaje = page.locator('input[type="text"]').first();
        if (await inputPersonaje.isVisible({ timeout: 5000 })) {
            await inputPersonaje.fill(roleId);
            
            const checkbox = page.locator('input[type="checkbox"]').first();
            const checkboxChecked = await checkbox.isChecked().catch(() => false);
            if (!checkboxChecked) {
                await checkbox.click();
            }
            await page.waitForTimeout(300);
            
            await page.locator('.userid-login-btn').first().click();
            await page.waitForTimeout(1500);
        }

        // Seleccionar paquete
        await page.waitForTimeout(1000);
        const goldOption = page.locator(paquete.selector).first();
        if (await goldOption.isVisible({ timeout: 2000 }).catch(() => false)) {
            await goldOption.click();
        }
        await page.waitForTimeout(1000);
        
        // Abrir carrito
        const carrito = page.locator('#sidebarCart, .sidebar-cart').first();
        if (await carrito.isVisible()) {
            await carrito.click();
        }
        await page.waitForTimeout(1000);
        
        // Activar NetEase Pay
        const netEasePayCheckbox = page.locator('.gc-checkbox-mobile, .shopping-with-gift-cards .bui-checkbox').first();
        if (await netEasePayCheckbox.isVisible({ timeout: 3000 })) {
            await netEasePayCheckbox.click();
        }
        await page.waitForTimeout(500);
        
        // Top-up
        const topUpBtn = page.locator('.cart-pay-btn').first();
        if (await topUpBtn.isVisible({ timeout: 3000 })) {
            await topUpBtn.click();
        }
        
        // PIN
        await page.waitForTimeout(1500);
        const pinInputs = page.locator('.pass-code-input');
        if (await pinInputs.first().isVisible({ timeout: 5000 })) {
            const pinDigits = CONFIG.pin.split('');
            for (let i = 0; i < pinDigits.length; i++) {
                await pinInputs.nth(i).click();
                await pinInputs.nth(i).fill(pinDigits[i]);
                await page.waitForTimeout(50);
            }
            
            await page.waitForTimeout(300);
            await page.locator('.action-btn.bui-button-primary').first().click();
            await page.waitForTimeout(2000);
        }
        
        await page.close();
        
    } catch (err) {
        error = err.message;
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
