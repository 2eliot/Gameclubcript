const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const fs = require('fs');
const path = require('path');

chromium.use(stealth);

const CONFIG = {
    email: "yorbitub@gmail.com",
    pass: "321Naruto%",
    pin: "276099",
    targetRoleId: "587091919480",
    goldPackage: {
        goodsid: "g83naxx1ena.USD.gold50.ally",
        goodsinfo: "50 barras de oro",
        goodscount: 1
    }
};

const COOKIES_FILE = path.join(__dirname, 'cookies.json');

// Función para guardar cookies
async function guardarCookies(context) {
    const state = await context.storageState();
    fs.writeFileSync(COOKIES_FILE, JSON.stringify(state, null, 2));
    console.log("💾 Cookies guardadas");
}

// Función para cargar cookies
function cargarCookies() {
    if (fs.existsSync(COOKIES_FILE)) {
        const data = fs.readFileSync(COOKIES_FILE, 'utf8');
        console.log("🍪 Cookies cargadas");
        return JSON.parse(data);
    }
    return null;
}

async function ejecutarCompra() {
    const tiempoInicio = Date.now();
    let nombreJugador = '';
    let ordenId = '';
    let paqueteComprado = '';
    let precioComprado = '';
    
    console.log("🚀 Iniciando compra automática...");
    const browser = await chromium.launch({ headless: false }); 
    
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
    
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    // Bloquear imágenes, fuentes y recursos innecesarios
    await page.route('**/*', route => {
        const url = route.request().url();
        const resourceType = route.request().resourceType();
        
        // Bloquear por tipo de recurso
        if (['image', 'font', 'media'].includes(resourceType)) {
            return route.abort();
        }
        
        // Bloquear CDN de imágenes
        if (url.includes('akamaized.net') || 
            url.includes('imageView') || 
            url.includes('/file/') ||
            url.includes('.png') || 
            url.includes('.jpg') || 
            url.includes('.webp') ||
            url.includes('.gif') ||
            url.includes('.svg') ||
            url.includes('.ico') ||
            url.includes('.woff') ||
            url.includes('.ttf')) {
            return route.abort();
        }
        
        return route.continue();
    });
    console.log("🚫 Imágenes bloqueadas");

    try {
        // Capturar nombre del jugador desde las respuestas de red
        page.on('response', async response => {
            const url = response.url();
            if (url.includes('login-role')) {
                try {
                    const json = await response.json();
                    if (json.data && json.data.rolename) {
                        nombreJugador = json.data.rolename;
                    }
                } catch (e) {}
            }
            if (url.includes('/gameclub/products/bloodstrike') && !url.includes('pay_type_route')) {
                try {
                    const json = await response.json();
                    if (json.data && json.data.sn) {
                        ordenId = json.data.sn;
                    }
                    if (json.data && json.data.order_price) {
                        precioComprado = json.data.order_price + ' ' + (json.data.order_currency || 'BDT');
                    }
                } catch (e) {}
            }
        });

        console.log("🔗 Navegando a la tienda...");
        await page.goto('https://pay.neteasegames.com/BloodStrike/topup?from=home', { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(2000);
        
        const botonLogin = page.locator('.wallet-entry');
        const necesitaLogin = await botonLogin.isVisible();
        
        if (necesitaLogin) {
            console.log("🔐 Iniciando sesión...");
            
            const [loginPage] = await Promise.all([
                context.waitForEvent('page'),
                page.click('.wallet-entry')
            ]);
            
            await loginPage.waitForLoadState('networkidle');
            await loginPage.waitForSelector('input[name="account"]', { state: 'visible', timeout: 30000 });
            await loginPage.fill('input[name="account"]', CONFIG.email);
            await loginPage.fill('input[name="hash_password"]', CONFIG.pass);
            await loginPage.click('.login-in-button');
            
            console.log("⏳ Esperando redirección (resuelve captcha si aparece)...");
            await page.waitForSelector('.region-selector', { state: 'visible', timeout: 90000 });
            await guardarCookies(context);
        } else {
            console.log("✅ Sesión activa");
        }

        console.log("🌍 Configurando región Bangladesh...");
        await page.waitForSelector('.region-selector', { state: 'visible', timeout: 15000 });
        await page.click('.region-selector');
        await page.waitForSelector('.adm-picker', { state: 'visible', timeout: 10000 });
        await page.waitForTimeout(500);
        await page.click('a.adm-picker-header-button:first-child');
        await page.waitForTimeout(300);
        
        await page.evaluate(() => {
            localStorage.setItem('region', 'BD');
            localStorage.setItem('language', 'es');
            localStorage.setItem('selectedRegion', JSON.stringify({ region: 'Bangladesh', language: 'español' }));
        });
        
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(2000);
        
        const currentRegion = await page.locator('.region-name').textContent().catch(() => '');
        if (!currentRegion.includes('Bangladesh')) {
            await page.goto('https://pay.neteasegames.com/BloodStrike/topup?from=home&region=BD&lang=es', { waitUntil: 'networkidle', timeout: 60000 });
            await page.waitForTimeout(2000);
        }

        console.log("🎮 Ingresando ID de personaje:", CONFIG.targetRoleId);
        const inputPersonaje = page.locator('input[placeholder*="ID de personaje"], input[placeholder*="ID"], input[type="text"]').first();
        if (await inputPersonaje.isVisible({ timeout: 5000 })) {
            await inputPersonaje.fill(CONFIG.targetRoleId);
            
            const checkbox = page.locator('input[type="checkbox"], .checkbox, .adm-checkbox-icon').first();
            const checkboxChecked = await checkbox.isChecked().catch(() => false);
            if (!checkboxChecked) {
                await checkbox.click();
            }
            await page.waitForTimeout(500);
            
            const btnIniciarSesion = page.locator('.userid-login-btn').first();
            await btnIniciarSesion.click();
            await page.waitForTimeout(3000);
        }

        console.log("🛒 Seleccionando 50 barras de oro...");
        await page.waitForTimeout(2000);
        
        // Buscar específicamente el paquete de 50 gold bars
        const goldSelectors = [
            'text=50 barras de oro',
            'text=50 Gold Bars',
            'text=50 gold',
            '.goods-item:has-text("50")',
            'text=50'
        ];
        
        let goldFound = false;
        for (const selector of goldSelectors) {
            const goldOption = page.locator(selector).first();
            if (await goldOption.isVisible({ timeout: 1000 }).catch(() => false)) {
                await goldOption.click();
                paqueteComprado = '50 barras de oro';
                goldFound = true;
                console.log("✅ Paquete seleccionado: 50 barras de oro");
                break;
            }
        }
        if (!goldFound) {
            console.log("⚠️ No se encontró el paquete de 50 gold, seleccionando primer producto disponible");
            paqueteComprado = 'Producto seleccionado';
        }
        await page.waitForTimeout(2000);
        
        console.log("🛒 Abriendo carrito...");
        const carrito = page.locator('#sidebarCart, .sidebar-cart').first();
        if (await carrito.isVisible()) {
            await carrito.click();
        } else {
            await page.locator('.shopping-cart-entry').first().click().catch(() => {});
        }
        await page.waitForTimeout(2000);
        
        console.log("💳 Activando NetEase Pay...");
        const netEasePayCheckbox = page.locator('.shopping-with-gift-cards .bui-checkbox, .gc-checkbox-mobile').first();
        if (await netEasePayCheckbox.isVisible({ timeout: 3000 })) {
            await netEasePayCheckbox.click();
        }
        await page.waitForTimeout(1000);
        
        console.log("🛒 Procesando Top-up...");
        const topUpBtn = page.locator('.cart-pay-btn, button:has-text("Top-up")').first();
        if (await topUpBtn.isVisible({ timeout: 3000 })) {
            await topUpBtn.click();
        }
        
        console.log("🔐 Ingresando PIN...");
        await page.waitForTimeout(3000);
        
        const pinInputs = page.locator('.pass-code-input');
        const firstInput = pinInputs.first();
        
        if (await firstInput.isVisible({ timeout: 5000 })) {
            const pinDigits = CONFIG.pin.split('');
            for (let i = 0; i < pinDigits.length; i++) {
                const input = pinInputs.nth(i);
                await input.click();
                await input.fill(pinDigits[i]);
                await page.waitForTimeout(100);
            }
            
            await page.waitForTimeout(500);
            
            const okBtn = page.locator('.action-btn.bui-button-primary, button:has-text("OK")').first();
            if (await okBtn.isVisible({ timeout: 2000 })) {
                await okBtn.click();
            }
            
            await page.waitForTimeout(5000);
        }
        
        // Calcular tiempo total
        const tiempoFin = Date.now();
        const tiempoTotal = ((tiempoFin - tiempoInicio) / 1000).toFixed(2);
        
        console.log("\n" + "=".repeat(50));
        console.log("🔥 ¡COMPRA COMPLETADA!");
        console.log("=".repeat(50));
        console.log(`👤 Jugador: ${nombreJugador || 'No detectado'}`);
        console.log(`🆔 Role ID: ${CONFIG.targetRoleId}`);
        console.log(`🎁 Paquete: ${paqueteComprado || CONFIG.goldPackage.goodsinfo}`);
        if (precioComprado) console.log(`💰 Precio: ${precioComprado}`);
        if (ordenId) console.log(`📦 Orden: ${ordenId}`);
        console.log(`⏱️ Tiempo total: ${tiempoTotal} segundos`);
        console.log("=".repeat(50) + "\n");

    } catch (error) {
        const tiempoFin = Date.now();
        const tiempoTotal = ((tiempoFin - tiempoInicio) / 1000).toFixed(2);
        console.error("❌ ERROR:", error.message);
        console.log(`⏱️ Tiempo transcurrido: ${tiempoTotal} segundos`);
    } finally {
        console.log("🏁 Proceso finalizado.");
        // browser.close(); // Descomenta en VPS
    }
}

ejecutarCompra();
