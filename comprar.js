const { loadEnvFile } = require('./env-loader');
loadEnvFile();

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

chromium.use(stealth);

const CONFIG = {
    email: process.env.GAME_EMAIL || '',
    pass: process.env.GAME_PASSWORD || '',
    pin: process.env.GAME_PIN || '',
    targetRoleId: process.env.DEFAULT_ROLE_ID || '587091919480',
    goldPackage: {
        goodsid: "g83naxx1ena.USD.gold50.ally",
        goodsinfo: "50 barras de oro",
        goodscount: 1
    }
};

const EXECUTION_CONFIG = {
    targetRoleId: process.env.ROLE_ID || CONFIG.targetRoleId,
    pin: process.env.PIN || CONFIG.pin,
    mapPackages: process.env.MAP_PACKAGES === 'true',
    packageKey: process.env.PACKAGE_KEY || ''
};
const RUN_HEADLESS = process.env.HEADLESS !== 'false';

const COOKIES_FILE = path.join(__dirname, 'cookies.json');
const STORE_URL = 'https://pay.neteasegames.com/BloodStrike/topup?from=home';
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

function isFirstPartyHost(hostname = '') {
    return hostname === 'pay.neteasegames.com' ||
        hostname.endsWith('.neteasegames.com') ||
        hostname.endsWith('.163.com') ||
        hostname.endsWith('.126.net');
}

function construirPackageKey(paquete) {
    const base = [paquete.title || '', paquete.price || '', paquete.rawText || '']
        .map(value => String(value).trim())
        .join('|');

    return `bs_${crypto.createHash('sha1').update(base).digest('hex').slice(0, 16)}`;
}

function construirExecutionConfig(overrides = {}) {
    const headless = overrides.headless ?? RUN_HEADLESS;

    return {
        targetRoleId: overrides.roleId || EXECUTION_CONFIG.targetRoleId,
        pin: overrides.pin || EXECUTION_CONFIG.pin,
        mapPackages: overrides.mapPackages ?? EXECUTION_CONFIG.mapPackages,
        packageKey: overrides.packageKey || EXECUTION_CONFIG.packageKey || '',
        headless,
        keepBrowserOpen: overrides.keepBrowserOpen ?? !headless
    };
}

function validarConfiguracion(executionConfig) {
    const faltantes = [];

    if (!CONFIG.email) {
        faltantes.push('GAME_EMAIL');
    }

    if (!CONFIG.pass) {
        faltantes.push('GAME_PASSWORD');
    }

    if (!executionConfig.mapPackages && !executionConfig.pin) {
        faltantes.push('GAME_PIN o PIN');
    }

    if (!executionConfig.targetRoleId) {
        faltantes.push('ROLE_ID o DEFAULT_ROLE_ID');
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

function attachResponseTracking(page, handlers) {
    if (page.__responseTrackingAttached) {
        return;
    }

    page.__responseTrackingAttached = true;
    page.on('response', async response => {
        const url = response.url();
        if (url.includes('login-role')) {
            try {
                const json = await response.json();
                if (json.data && json.data.rolename) {
                    handlers.onRoleName(json.data.rolename);
                }
            } catch (e) {}
        }
        if (url.includes('/gameclub/products/bloodstrike') && !url.includes('pay_type_route')) {
            try {
                const json = await response.json();
                if (json.data && json.data.sn) {
                    handlers.onOrderId(json.data.sn);
                }
                if (json.data && json.data.order_price) {
                    handlers.onOrderPrice(json.data.order_price + ' ' + (json.data.order_currency || 'BDT'));
                }
            } catch (e) {}
        }
    });
}

async function cuentaVisiblePorCorreo(page) {
    const email = (CONFIG.email || '').toLowerCase();
    const [localPart = '', domainPart = ''] = email.split('@');
    const localPrefix = localPart.slice(0, 3);
    const localSuffix = localPart.slice(-2);

    return page.waitForFunction(({ localPrefix: prefix, localSuffix: suffix, domainPart: domain }) => {
        const bodyText = (document.body?.innerText || '').toLowerCase();
        const hasDomain = domain ? bodyText.includes(domain) : false;
        const hasPrefix = prefix ? bodyText.includes(prefix) : false;
        const hasSuffix = suffix ? bodyText.includes(suffix) : false;
        return hasDomain && hasPrefix && hasSuffix;
    }, { localPrefix, localSuffix, domainPart }, { timeout: 2000 }).then(() => true).catch(() => false);
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

function waitForPayPasswordReadyResponse(page, timeout = 15000) {
    return page.waitForResponse(async response => {
        const contentType = response.headers()['content-type'] || '';
        if (!contentType.includes('application/json')) {
            return false;
        }

        try {
            const json = await response.json();
            return json &&
                json.code === '0000' &&
                json.data &&
                json.data.paypasswd_ready === true;
        } catch (error) {
            return false;
        }
    }, { timeout });
}

async function navegarEnMismaPestana(page, url, timeout = 45000) {
    await Promise.all([
        page.waitForURL(targetUrl => targetUrl.toString().startsWith(url), { timeout }).catch(() => {}),
        page.evaluate(targetUrl => {
            window.location.assign(targetUrl);
        }, url)
    ]);

    await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {});
}

async function esperarProductosDisponibles(page, timeout = 15000) {
    const goodsSelector = '.goods-item, [data-goodsid], [data-goods-id]';

    const responseReady = waitForProductsResponse(page, timeout).then(() => true).catch(() => false);
    const goodsReady = page.waitForSelector(goodsSelector, { state: 'visible', timeout }).then(() => true).catch(() => false);

    const result = await Promise.race([responseReady, goodsReady]);
    if (result) {
        return;
    }

    await Promise.allSettled([responseReady, goodsReady]);
    throw new Error('Los productos no quedaron disponibles después del login del personaje');
}

async function obtenerTriggerLoginVisible(page) {
    const walletEntry = page.locator('.wallet-entry').first();
    if (await walletEntry.isVisible({ timeout: 3000 }).catch(() => false)) {
        const walletText = (await walletEntry.textContent().catch(() => '') || '').trim().toLowerCase();
        if (walletText.includes('log in') || walletText.includes('iniciar sesión')) {
            return walletEntry;
        }
    }

    return null;
}

async function sesionActiva(page) {
    if (await cuentaVisiblePorCorreo(page)) {
        return true;
    }

    const loginTrigger = await obtenerTriggerLoginVisible(page);
    if (loginTrigger) {
        return false;
    }

    const walletSelectors = [
        '.wallet-info',
        '.user-wallet-info',
        '.wallet-balance',
        '.wallet-user-info'
    ];

    for (const selector of walletSelectors) {
        if (await page.locator(selector).first().isVisible({ timeout: 800 }).catch(() => false)) {
            return true;
        }
    }

    return false;
}

async function flujoCompraDisponible(page) {
    const selectors = [
        'input[placeholder="Please enter User ID"]',
        'input[placeholder*="Please enter User ID"]',
        '.userid-login-btn',
        '.goods-item',
        '[data-goodsid]',
        '[data-goods-id]'
    ];

    for (const selector of selectors) {
        if (await page.locator(selector).first().isVisible({ timeout: 1000 }).catch(() => false)) {
            return true;
        }
    }

    return false;
}

async function esperarTransicionLogin(popup, page) {
    const loadingSelectors = [
        '.bui-loading',
        '.adm-dot-loading',
        '.adm-spin-loading',
        '.loading',
        '[class*="loading"]'
    ];

    for (const selector of loadingSelectors) {
        const loader = popup.locator(selector).first();
        const visible = await loader.isVisible({ timeout: 1500 }).catch(() => false);
        if (visible) {
            await loader.waitFor({ state: 'hidden', timeout: 20000 }).catch(() => {});
            break;
        }
    }

    await Promise.race([
        popup.waitForEvent('close', { timeout: 30000 }).catch(() => {}),
        popup.waitForURL(url => !url.toString().includes('account/login'), { timeout: 30000 }).catch(() => {}),
        page.waitForFunction(() => {
            const walletEntryNode = document.querySelector('.wallet-entry');
            const walletText = walletEntryNode?.textContent?.trim().toLowerCase() || '';
            const hasWalletInfo = Boolean(document.querySelector('.wallet-info, .user-wallet-info, .wallet-balance, .wallet-user-info'));
            const hasUserIdForm = Boolean(document.querySelector('input[placeholder="Please enter User ID"], input[placeholder*="Please enter User ID"], .userid-login-btn'));
            return hasWalletInfo || hasUserIdForm || (walletEntryNode && walletText && !walletText.includes('log in') && !walletText.includes('iniciar sesión'));
        }, { timeout: 30000 }).catch(() => {})
    ]);
}

async function esperarSesionActiva(context, page, timeout = 20000) {
    await page.bringToFront().catch(() => {});

    const loginResolved = await page.waitForFunction(() => {
        const walletEntry = document.querySelector('.wallet-entry');
        const walletText = walletEntry?.textContent?.trim().toLowerCase() || '';
        const hasWalletInfo = Boolean(
            document.querySelector('.wallet-info, .user-wallet-info, .wallet-balance, .wallet-user-info')
        );

        return hasWalletInfo || (walletEntry && walletText && !walletText.includes('log in') && !walletText.includes('iniciar sesión'));
    }, { timeout }).then(() => true).catch(() => false);

    if (loginResolved) {
        return true;
    }

    const cookies = await context.cookies();
    const hasNetEaseSession = cookies.some(cookie => {
        const domain = cookie.domain || '';
        return (domain.includes('neteasegames.com') || domain.includes('163.com') || domain.includes('126.net')) && !!cookie.value;
    });

    if (!hasNetEaseSession) {
        return false;
    }

    await Promise.race([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
        page.waitForURL(url => url.toString().includes('/BloodStrike/topup'), { timeout: 15000 }).catch(() => {}),
        page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {})
    ]);

    await page.waitForSelector('.wallet-entry, .wallet-info, .user-wallet-info, .wallet-balance, .wallet-user-info, .userid-login-btn', {
        state: 'visible',
        timeout: 10000
    }).catch(() => {});

    return sesionActiva(page);
}

async function completarLoginWalletPopup(context, page) {
    const walletEntry = page.locator('.wallet-entry').first();
    await walletEntry.waitFor({ state: 'visible', timeout: 15000 });

    const [popup] = await Promise.all([
        context.waitForEvent('page', { timeout: 15000 }),
        walletEntry.click()
    ]);

    attachResponseTracking(popup, {
        onRoleName: () => {},
        onOrderId: () => {},
        onOrderPrice: () => {}
    });

    await popup.waitForLoadState('domcontentloaded');
    const accountInput = popup.locator('input[name="account"], input[type="email"], input[name="email"]').first();
    const passwordInput = popup.locator('input[name="hash_password"], input[type="password"]').first();
    const loginButton = popup.locator('.login-in-button, button:has-text("Log in"), button:has-text("Iniciar sesión")').first();

    await accountInput.waitFor({ state: 'visible', timeout: 30000 });
    console.log('✍️ Rellenando credenciales de login...');
    await accountInput.fill(CONFIG.email);
    await passwordInput.waitFor({ state: 'visible', timeout: 10000 });
    await passwordInput.fill(CONFIG.pass);
    await loginButton.waitFor({ state: 'visible', timeout: 10000 });
    await loginButton.click();

    await esperarTransicionLogin(popup, page);

    await guardarCookies(context);
}

async function asegurarSesionActiva(context, page) {
    console.log('🔗 Abriendo la tienda antes del login...');
    await navegarEnMismaPestana(page, STORE_URL, 45000);
    await page.waitForSelector('.wallet-entry, .wallet-info, .user-wallet-info, .wallet-balance, .wallet-user-info', {
        state: 'visible',
        timeout: 15000
    }).catch(() => {});

    if (!(await sesionActiva(page))) {
        console.log('🔐 Sesión no activa, iniciando login desde wallet-entry...');
        await completarLoginWalletPopup(context, page);
    }

    await page.waitForSelector('.wallet-entry, .wallet-info, .user-wallet-info, .wallet-balance, .wallet-user-info', {
        state: 'visible',
        timeout: 15000
    }).catch(() => {});

    if (!(await sesionActiva(page)) && !(await flujoCompraDisponible(page))) {
        throw new Error('El login por popup no dejó la sesión activa en la tienda');
    }

    console.log('✅ Flujo disponible en la pestaña principal después del login');
    return page;
}

async function obtenerInputRoleId(page) {
    const selectors = [
        'input[placeholder="Please enter User ID"]:not([disabled]):not([readonly])',
        'input[placeholder*="Please enter User ID"]:not([disabled]):not([readonly])',
        'xpath=//*[normalize-space()="User"]/following::input[not(@disabled) and not(@readonly)][1]',
        '.userid-content input[placeholder*="User ID"]:not([disabled]):not([readonly])',
        '.userid-content input:not([disabled]):not([readonly])'
    ];

    for (const selector of selectors) {
        const input = page.locator(selector).first();
        if (await input.isVisible({ timeout: 1200 }).catch(() => false) && await input.isEnabled().catch(() => false)) {
            return input;
        }
    }

    const inputsDebug = await page.locator('input').evaluateAll(elements => {
        return elements.map(element => ({
            placeholder: element.getAttribute('placeholder') || '',
            type: element.getAttribute('type') || '',
            value: element.value || '',
            disabled: element.disabled,
            readOnly: element.readOnly,
            inputMode: element.getAttribute('inputmode') || '',
            visible: !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length)
        }));
    }).catch(() => []);

    throw new Error(`No se encontró un input editable para el ID del personaje. Inputs detectados: ${JSON.stringify(inputsDebug)}`);
}

async function obtenerRoleIdResuelto(page, roleId) {
    const resolvedSelectors = [
        'input[placeholder="Please enter User ID"][disabled]',
        'input[placeholder*="Please enter User ID"][disabled]',
        'input[placeholder*="User ID"][disabled]',
        'xpath=//*[normalize-space()="User"]/following::input[@disabled][1]'
    ];

    for (const selector of resolvedSelectors) {
        const input = page.locator(selector).first();
        if (await input.isVisible({ timeout: 1000 }).catch(() => false)) {
            const value = (await input.inputValue().catch(() => '') || '').trim();
            if (!roleId || value.includes(roleId)) {
                return value;
            }
        }
    }

    return '';
}

async function activarCheckboxTerminos(page) {
    const checkbox = page.locator('label:has-text("Privacy Policy"), label:has-text("User Agreement"), .bui-checkbox, .gc-checkbox-mobile, input[type="checkbox"]').first();
    if (!(await checkbox.isVisible({ timeout: 1500 }).catch(() => false))) {
        return;
    }

    const marcado = await checkbox.evaluate(element => {
        const classChecked = element.classList.contains('bui-checkbox-checked');
        const nestedInput = element.matches('input[type="checkbox"]') ? element : element.querySelector('input[type="checkbox"]');
        return classChecked || Boolean(nestedInput && nestedInput.checked);
    }).catch(() => false);

    if (!marcado) {
        await checkbox.click({ force: true });
    }
}

async function obtenerBotonLoginPersonaje(page) {
    const selectors = [
        '.userid-login-btn',
        'button.bui-button:has-text("Log in")',
        'button:has-text("Log in")'
    ];

    for (const selector of selectors) {
        const button = page.locator(selector).first();
        if (await button.isVisible({ timeout: 1200 }).catch(() => false)) {
            return button;
        }
    }

    throw new Error('No se encontró el botón Log in del formulario de personaje');
}

async function esperarFormularioPersonajeListo(page, timeout = 20000) {
    const loadingSelectors = [
        '.bui-loading',
        '.adm-dot-loading',
        '.adm-spin-loading',
        '.loading',
        '[class*="loading"]'
    ];

    for (const selector of loadingSelectors) {
        const loader = page.locator(selector).first();
        const visible = await loader.isVisible({ timeout: 1000 }).catch(() => false);
        if (visible) {
            await loader.waitFor({ state: 'hidden', timeout }).catch(() => {});
        }
    }

    await page.waitForFunction(() => {
        const input = document.querySelector('input[placeholder="Please enter User ID"], input[placeholder*="Please enter User ID"], .userid-content input:not([disabled]):not([readonly])');
        if (!input) {
            return false;
        }

        const style = window.getComputedStyle(input);
        const rect = input.getBoundingClientRect();
        const inputReady = !input.disabled && !input.readOnly && style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        const activeLoader = Array.from(document.querySelectorAll('.bui-loading, .adm-dot-loading, .adm-spin-loading, .loading, [class*="loading"]'))
            .some(element => {
                const loaderStyle = window.getComputedStyle(element);
                const loaderRect = element.getBoundingClientRect();
                return loaderStyle.display !== 'none' && loaderStyle.visibility !== 'hidden' && loaderRect.width > 20 && loaderRect.height > 20;
            });

        return inputReady && !activeLoader;
    }, { timeout });
}

async function ingresarRoleIdYEsperarProductos(page, roleId) {
    for (let intento = 1; intento <= 2; intento++) {
        try {
            const roleIdResuelto = await obtenerRoleIdResuelto(page, roleId);
            if (roleIdResuelto) {
                console.log(`✅ User ID ya resuelto en la página: ${roleIdResuelto}`);
                await esperarProductosDisponibles(page, 15000);
                return;
            }

            await esperarFormularioPersonajeListo(page, 20000);
            const inputPersonaje = await obtenerInputRoleId(page);
            await inputPersonaje.waitFor({ state: 'visible', timeout: 5000 });
            await inputPersonaje.fill(roleId);

            await activarCheckboxTerminos(page);

            const productosPromise = esperarProductosDisponibles(page, 15000);
            const btnIniciarSesion = await obtenerBotonLoginPersonaje(page);
            await btnIniciarSesion.waitFor({ state: 'visible', timeout: 5000 });
            await btnIniciarSesion.click({ force: true });
            await productosPromise;
            return;
        } catch (error) {
            if (intento === 2) {
                throw new Error(`No fue posible ingresar el ID del personaje: ${error.message}`);
            }

            console.log('🔁 Reintentando carga del formulario de personaje...');
            await navegarEnMismaPestana(page, STORE_URL, 45000);
            await page.waitForSelector('.region-name, .userid-login-btn, input[type="text"]', { state: 'visible', timeout: 15000 });
        }
    }
}

async function seleccionarPaquete(page, paquete) {
    const goldSelectors = [
        `[data-goodsid="${paquete.goodsid}"]`,
        `[data-goods-id="${paquete.goodsid}"]`,
        `text=${paquete.goodsinfo}`,
        'text=50 barras de oro',
        'text=50 Gold Bars',
        'text=50 gold',
        '.goods-item:has-text("50")',
        'text=50'
    ];

    for (const selector of goldSelectors) {
        const goldOption = page.locator(selector).first();
        if (await goldOption.isVisible({ timeout: 1200 }).catch(() => false)) {
            await goldOption.click();
            return paquete.goodsinfo;
        }
    }

    throw new Error('No se encontró el paquete configurado en la grilla de productos');
}

async function extraerPaquetesVisibles(page) {
    return page.locator('.goods-item, [data-goodsid], [data-goods-id]').evaluateAll(elements => {
        const seen = new Set();

        return elements.map(element => {
            const goodsid = element.getAttribute('data-goodsid') || element.getAttribute('data-goods-id') || null;
            const rawText = (element.textContent || '').replace(/\s+/g, ' ').trim();
            const title = rawText.split(/BDT/i)[0].trim() || rawText;
            const priceMatch = rawText.match(/BDT\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
            const price = priceMatch ? `BDT ${priceMatch[1]}` : null;
            const normalized = `${goodsid || ''}::${title}::${price || ''}`;

            if (!rawText || seen.has(normalized)) {
                return null;
            }

            seen.add(normalized);
            return {
                goodsid,
                title,
                price,
                rawText,
                packageKey: null
            };
        }).filter(Boolean);
    }).then(paquetes => paquetes.map(paquete => ({
        ...paquete,
        packageKey: construirPackageKey(paquete)
    })));
}

async function seleccionarPaqueteMapeado(page, packageKey) {
    const paquetes = await extraerPaquetesVisibles(page);
    const target = paquetes.find(paquete => paquete.packageKey === packageKey);

    if (!target) {
        throw new Error(`No se encontró el paquete mapeado ${packageKey} en la grilla actual`);
    }

    const selectors = [
        target.goodsid ? `[data-goodsid="${target.goodsid}"]` : null,
        target.goodsid ? `[data-goods-id="${target.goodsid}"]` : null,
        `text=${target.rawText}`,
        `text=${target.title}`
    ].filter(Boolean);

    for (const selector of selectors) {
        const option = page.locator(selector).first();
        if (await option.isVisible({ timeout: 1200 }).catch(() => false)) {
            await option.click();
            return target.title;
        }
    }

    throw new Error(`No se pudo seleccionar el paquete mapeado ${packageKey}`);
}

function construirResultadoCompra(payload) {
    return {
        success: payload.success,
        mode: payload.mode || 'buy-package',
        roleId: payload.roleId,
        jugador: payload.jugador || null,
        paquete: payload.paquete || null,
        precio: payload.precio || null,
        orden: payload.orden || null,
        tiempo: payload.tiempo || null,
        total: payload.total,
        paquetes: payload.paquetes,
        fetchedAt: payload.fetchedAt,
        packageKey: payload.packageKey || null,
        error: payload.error || null
    };
}

async function activarNetEasePay(page) {
    const netEasePayCheckbox = page.locator('.shopping-with-gift-cards .bui-checkbox, .gc-checkbox-mobile').first();
    await netEasePayCheckbox.waitFor({ state: 'visible', timeout: 10000 });
    await netEasePayCheckbox.evaluate(element => {
        element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    }).catch(() => {});

    const yaSeleccionado = await netEasePayCheckbox.evaluate(element => {
        const classChecked = element.classList.contains('bui-checkbox-checked');
        const input = element.querySelector('input[type="checkbox"]');
        return classChecked || Boolean(input && input.checked);
    }).catch(() => false);

    if (yaSeleccionado) {
        console.log('✅ NetEase Pay ya estaba activo');
        return;
    }

    await netEasePayCheckbox.evaluate(element => {
        const input = element.matches('input[type="checkbox"]') ? element : element.querySelector('input[type="checkbox"]');
        if (input && !input.checked) {
            input.click();
            return;
        }

        element.click();
    }).catch(() => {});

    let activado = await netEasePayCheckbox.evaluate(element => {
        const classChecked = element.classList.contains('bui-checkbox-checked');
        const input = element.querySelector('input[type="checkbox"]');
        return classChecked || Boolean(input && input.checked);
    }).catch(() => false);

    if (!activado) {
        const box = await netEasePayCheckbox.boundingBox().catch(() => null);
        if (box) {
            await page.mouse.click(box.x + (box.width / 2), box.y + (box.height / 2));
        }
    }

    await esperarCheckoutListo(page, 20000);

    activado = await netEasePayCheckbox.evaluate(element => {
        const classChecked = element.classList.contains('bui-checkbox-checked');
        const input = element.querySelector('input[type="checkbox"]');
        return classChecked || Boolean(input && input.checked);
    }).catch(() => false);

    if (!activado) {
        throw new Error('No se pudo activar NetEase Pay');
    }
}

async function carritoYaExpuesto(page) {
    const visibles = [
        '.shopping-with-gift-cards .bui-checkbox',
        '.gc-checkbox-mobile',
        '.cart-pay-btn',
        '.shopping-cart-popup .cart-pay-btn'
    ];

    for (const selector of visibles) {
        const locator = page.locator(selector).first();
        if (await locator.isVisible({ timeout: 1000 }).catch(() => false) && await locator.evaluate(element => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
        }).catch(() => false)) {
            return true;
        }
    }

    return false;
}

async function asegurarCheckoutVisible(page) {
    const anchors = [
        '.shopping-cart-action .cart-pay-btn',
        '.shopping-cart-action button:has-text("Top-up")',
        '.cart-pay-btn',
        'button:has-text("Top-up")',
        'button:has-text("Top up")',
        '.shopping-with-gift-cards .bui-checkbox',
        '.gc-checkbox-mobile'
    ];

    for (const selector of anchors) {
        const locator = page.locator(selector).first();
        if (await locator.isVisible({ timeout: 1000 }).catch(() => false)) {
            await locator.scrollIntoViewIfNeeded().catch(() => {});
            const inViewport = await locator.evaluate(element => {
                const rect = element.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
            }).catch(() => false);

            if (inViewport) {
                return true;
            }
        }
    }

    await page.mouse.wheel(0, 1200).catch(() => {});
    return false;
}

async function desplazarHastaTopUp(page) {
    const targetSelectors = [
        '.shopping-cart-action .cart-pay-btn',
        '.shopping-cart-action button:has-text("Top-up")',
        '.cart-pay-btn.bui-button',
        'button:has-text("Top-up")'
    ];

    for (let intento = 0; intento < 5; intento++) {
        for (const selector of targetSelectors) {
            const button = page.locator(selector).first();
            if (await button.isVisible({ timeout: 800 }).catch(() => false)) {
                await button.evaluate(element => {
                    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
                }).catch(() => {});

                const inViewport = await button.evaluate(element => {
                    const rect = element.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
                }).catch(() => false);

                if (inViewport) {
                    return true;
                }
            }
        }

        await page.mouse.wheel(0, 800).catch(() => {});
    }

    return false;
}

async function esperarCheckoutListo(page, timeout = 20000) {
    const loadingSelectors = [
        '.bui-loading',
        '.adm-dot-loading',
        '.adm-spin-loading',
        '.loading',
        '[class*="loading"]'
    ];

    for (const selector of loadingSelectors) {
        const loader = page.locator(selector).first();
        const visible = await loader.isVisible({ timeout: 1000 }).catch(() => false);
        if (visible) {
            await loader.waitFor({ state: 'hidden', timeout }).catch(() => {});
        }
    }

    await page.waitForFunction(() => {
        const payCheckbox = document.querySelector('.shopping-with-gift-cards .bui-checkbox, .gc-checkbox-mobile');
        const topUpButton = document.querySelector('.cart-pay-btn, button');
        const activeLoader = Array.from(document.querySelectorAll('.bui-loading, .adm-dot-loading, .adm-spin-loading, .loading, [class*="loading"]'))
            .some(element => {
                const style = window.getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 20 && rect.height > 20;
            });

        return !activeLoader && Boolean(payCheckbox || topUpButton);
    }, { timeout });
}

async function asegurarCartCheckoutAccesible(page) {
    if (await asegurarCheckoutVisible(page)) {
        await esperarCheckoutListo(page, 20000);
        return;
    }

    const carrito = page.locator('#sidebarCart, .sidebar-cart, .shopping-cart-entry').first();
    if (await carrito.isVisible({ timeout: 1500 }).catch(() => false)) {
        console.log('🛒 Abriendo carrito como fallback');
        await carrito.click({ force: true }).catch(() => {});
    }

    await asegurarCheckoutVisible(page);
    await esperarCheckoutListo(page, 20000);
}

async function esperarPopupPin(page, timeout = 15000) {
    const pinInput = page.locator('.pass-code-input').first();
    const pinModalSelectors = [
        '.pass-code-input',
        '.action-btn.bui-button-primary',
        'button:has-text("OK")'
    ];

    for (const selector of pinModalSelectors) {
        const locator = page.locator(selector).first();
        if (await locator.isVisible({ timeout: 1200 }).catch(() => false)) {
            await pinInput.waitFor({ state: 'visible', timeout }).catch(() => {});
            return pinInput;
        }
    }

    await pinInput.waitFor({ state: 'visible', timeout });
    return pinInput;
}

async function clickTopUpAndEsperarPin(page, topUpBtn) {
    await topUpBtn.scrollIntoViewIfNeeded().catch(() => {});
    await topUpBtn.evaluate(element => {
        element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    }).catch(() => {});

    let clicked = false;

    try {
        await topUpBtn.click({ timeout: 5000 });
        clicked = true;
    } catch (error) {
        const box = await topUpBtn.boundingBox().catch(() => null);
        if (box) {
            await page.mouse.click(box.x + (box.width / 2), box.y + (box.height / 2));
            clicked = true;
        }
    }

    if (!clicked) {
        await topUpBtn.evaluate(element => {
            element.click();
        }).catch(() => {});
    }

    const payPasswordReady = await waitForPayPasswordReadyResponse(page, 15000).then(() => true).catch(() => false);
    const pinInput = await esperarPopupPin(page, payPasswordReady ? 20000 : 15000).catch(() => null);
    if (!pinInput) {
        if (payPasswordReady) {
            throw new Error('El backend confirmó paypasswd_ready, pero el popup del PIN no apareció');
        }

        throw new Error('Se pulsó Top-up pero el popup del PIN no apareció');
    }

    return pinInput;
}

async function obtenerBotonTopUp(context, page) {
    await asegurarCartCheckoutAccesible(page);
    await desplazarHastaTopUp(page);
    await page.waitForSelector('.shopping-cart-action .cart-pay-btn, .shopping-cart-action button', {
        state: 'visible',
        timeout: 15000
    }).catch(() => {});

    const topUpSelectors = [
        '.shopping-cart-action .cart-pay-btn',
        '.shopping-cart-action button:has-text("Top-up")',
        '.cart-pay-btn.bui-button',
        'button:has-text("Top-up")',
        'button:has-text("Top up")',
        '.cart-pay-btn',
        'button:has-text("Pay")'
    ];

    for (const selector of topUpSelectors) {
        const button = page.locator(selector).first();
        if (await button.isVisible({ timeout: 1200 }).catch(() => false)) {
            await button.scrollIntoViewIfNeeded().catch(() => {});
            const inViewport = await button.evaluate(element => {
                const rect = element.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
            }).catch(() => false);

            if (inViewport) {
                return button;
            }
        }
    }

    const buttonTexts = await page.locator('button').evaluateAll(elements => {
        return elements
            .map(element => element.textContent ? element.textContent.trim() : '')
            .filter(Boolean)
            .slice(0, 12);
    }).catch(() => []);

    throw new Error(`No se encontró el botón Top-up. Botones visibles: ${buttonTexts.join(' | ') || 'ninguno'}`);
}

async function ejecutarCompra(options = {}) {
    const executionConfig = construirExecutionConfig(options);
    const runHeadless = executionConfig.headless;
    const tiempoInicio = Date.now();
    let nombreJugador = '';
    let ordenId = '';
    let paqueteComprado = '';
    let precioComprado = '';
    
    console.log("🚀 Iniciando compra automática...");
    validarConfiguracion(executionConfig);
    const browser = await chromium.launch({
        headless: runHeadless,
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
        viewport: { width: 430, height: 1180 },
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1',
        isMobile: true,
        hasTouch: true,
        ignoreHTTPSErrors: true
    };
    
    if (cookiesData) {
        contextOptions.storageState = cookiesData;
    }
    
    const context = await browser.newContext(contextOptions);
    await applyPrewarm(context);
    let currentPage = await context.newPage();

    // Mantener CSS pero cortar fuentes, imágenes de terceros y analíticas.
    await context.route('**/*', route => {
        if (shouldAbortRequest(route.request())) {
            return route.abort();
        }

        return route.continue();
    });
    console.log("🚫 Recursos no críticos bloqueados");

    try {
        const trackingHandlers = {
            onRoleName: value => {
                nombreJugador = value;
            },
            onOrderId: value => {
                ordenId = value;
            },
            onOrderPrice: value => {
                precioComprado = value;
            }
        };

        attachResponseTracking(currentPage, trackingHandlers);
        context.on('page', newPage => {
            attachResponseTracking(newPage, trackingHandlers);
        });

        currentPage = await asegurarSesionActiva(context, currentPage) || currentPage;

        console.log("🔗 Navegando a la tienda...");
        await currentPage.waitForSelector('.wallet-entry, .region-name, .userid-login-btn, input[type="text"]', { state: 'visible', timeout: 15000 });

        console.log("🌍 Región y lenguaje precargados antes de la navegación inicial");
        const currentRegion = await currentPage.locator('.region-name').textContent().catch(() => '');
        if (!currentRegion.includes('Bangladesh')) {
            await navegarEnMismaPestana(currentPage, STORE_URL, 45000);
            await currentPage.waitForSelector('.region-name, .userid-login-btn, input[type="text"]', { state: 'visible', timeout: 15000 });
        }

        console.log("🎮 Ingresando ID de personaje:", executionConfig.targetRoleId);
        await ingresarRoleIdYEsperarProductos(currentPage, executionConfig.targetRoleId);

        if (executionConfig.mapPackages) {
            await currentPage.waitForSelector('.goods-item, [data-goodsid], [data-goods-id]', {
                state: 'visible',
                timeout: 15000
            });
            const paquetes = await extraerPaquetesVisibles(currentPage);
            return construirResultadoCompra({
                success: true,
                mode: 'map-packages',
                roleId: executionConfig.targetRoleId,
                total: paquetes.length,
                paquetes,
                fetchedAt: new Date().toISOString()
            });
        }

        console.log("🛒 Seleccionando paquete...");
        await currentPage.waitForSelector('.goods-item, [data-goodsid], [data-goods-id]', { state: 'visible', timeout: 10000 });
        if (executionConfig.packageKey) {
            paqueteComprado = await seleccionarPaqueteMapeado(currentPage, executionConfig.packageKey);
        } else {
            paqueteComprado = await seleccionarPaquete(currentPage, CONFIG.goldPackage);
        }
        console.log(`✅ Paquete seleccionado: ${paqueteComprado}`);
        
        if (await carritoYaExpuesto(currentPage)) {
            console.log("🛒 Carrito ya expuesto en pantalla");
        } else {
            console.log("🛒 Abriendo carrito...");
            const carrito = currentPage.locator('#sidebarCart, .sidebar-cart').first();
            if (await carrito.isVisible().catch(() => false)) {
                await carrito.click();
            } else {
                await currentPage.locator('.shopping-cart-entry').first().click().catch(() => {});
            }
        }
        await currentPage.waitForSelector('.shopping-with-gift-cards .bui-checkbox, .gc-checkbox-mobile', { state: 'visible', timeout: 10000 });
        
        console.log("💳 Activando NetEase Pay...");
        await activarNetEasePay(currentPage);
        
        console.log("🛒 Procesando Top-up...");
        const topUpBtn = await obtenerBotonTopUp(context, currentPage);
        const firstInput = await clickTopUpAndEsperarPin(currentPage, topUpBtn);
        
        console.log("🔐 Ingresando PIN...");
        const pinInputs = currentPage.locator('.pass-code-input');

        await firstInput.click();
        for (const pinDigit of executionConfig.pin.split('')) {
            await currentPage.keyboard.press(pinDigit, { delay: 50 });
        }

        const okBtn = currentPage.locator('.action-btn.bui-button-primary, button:has-text("OK")').first();
        if (await okBtn.isVisible({ timeout: 5000 })) {
            await okBtn.click();
        }

        await firstInput.waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
        
        // Calcular tiempo total
        const tiempoFin = Date.now();
        const tiempoTotal = ((tiempoFin - tiempoInicio) / 1000).toFixed(2);
        
        console.log("\n" + "=".repeat(50));
        console.log("🔥 ¡COMPRA COMPLETADA!");
        console.log("=".repeat(50));
        console.log(`👤 Jugador: ${nombreJugador || 'No detectado'}`);
        console.log(`🆔 Role ID: ${executionConfig.targetRoleId}`);
        console.log(`🎁 Paquete: ${paqueteComprado || CONFIG.goldPackage.goodsinfo}`);
        if (precioComprado) console.log(`💰 Precio: ${precioComprado}`);
        if (ordenId) console.log(`📦 Orden: ${ordenId}`);
        console.log(`⏱️ Tiempo total: ${tiempoTotal} segundos`);
        console.log("=".repeat(50) + "\n");

        return construirResultadoCompra({
            success: true,
            roleId: executionConfig.targetRoleId,
            jugador: nombreJugador,
            paquete: paqueteComprado || CONFIG.goldPackage.goodsinfo,
            precio: precioComprado,
            orden: ordenId,
            tiempo: `${tiempoTotal} segundos`,
            packageKey: executionConfig.packageKey || null
        });

    } catch (error) {
        const tiempoFin = Date.now();
        const tiempoTotal = ((tiempoFin - tiempoInicio) / 1000).toFixed(2);
        console.error("❌ ERROR:", error.message);
        console.log(`⏱️ Tiempo transcurrido: ${tiempoTotal} segundos`);
        return construirResultadoCompra({
            success: false,
            roleId: executionConfig.targetRoleId,
            paquete: paqueteComprado || null,
            precio: precioComprado,
            orden: ordenId,
            tiempo: `${tiempoTotal} segundos`,
            packageKey: executionConfig.packageKey || null,
            error: error.message
        });
    } finally {
        console.log("🏁 Proceso finalizado.");
        if (!executionConfig.keepBrowserOpen) {
            await browser.close();
        } else {
            console.log("👀 Navegador visible se mantiene abierto para inspección manual.");
        }
    }
}

async function mapearPaquetes(roleId, options = {}) {
    return ejecutarCompra({
        ...options,
        roleId,
        mapPackages: true,
        keepBrowserOpen: false
    });
}

if (require.main === module) {
    ejecutarCompra().then(resultado => {
        if (resultado && resultado.mode === 'map-packages') {
            console.log(JSON.stringify(resultado, null, 2));
        }
    });
}

module.exports = {
    CONFIG,
    construirPackageKey,
    ejecutarCompra,
    mapearPaquetes
};
