const { loadEnvFile } = require('./env-loader');
loadEnvFile();

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ejecutarCompra, mapearPaquetes } = require('./comprar');

const app = express();
app.use(express.json());

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT || (IS_PRODUCTION ? 5005 : 5006));
const MAX_CONCURRENCIA = 2;
const REQUEST_STORE_FILE = path.join(__dirname, 'game-request-store.json');
const REQUEST_QUEUE_STALE_MS = Number(process.env.REQUEST_QUEUE_STALE_MS || 2 * 60 * 1000);
const REQUEST_PROCESSING_STALE_MS = Number(process.env.REQUEST_PROCESSING_STALE_MS || 10 * 60 * 1000);
const DEFAULT_PACKAGES = {
    '50_gold': { goodsid: 'g83naxx1ena.USD.gold50.ally', goodsinfo: '50 barras de oro' },
    '100_gold': { goodsid: 'g83naxx1ena.USD.gold100.ally', goodsinfo: '100 barras de oro' },
    '300_gold': { goodsid: 'g83naxx1ena.USD.gold300.ally', goodsinfo: '300 barras de oro' },
    '500_gold': { goodsid: 'g83naxx1ena.USD.gold500.ally', goodsinfo: '500 barras de oro' },
    '1000_gold': { goodsid: 'g83naxx1ena.USD.gold1000.ally', goodsinfo: '1000 barras de oro' }
};

let tareasActivas = 0;
const colaEspera = [];
const requestIdsActivos = new Set();

function leerRequestStore() {
    if (!fs.existsSync(REQUEST_STORE_FILE)) {
        return {};
    }

    try {
        return JSON.parse(fs.readFileSync(REQUEST_STORE_FILE, 'utf8'));
    } catch (error) {
        return {};
    }
}

function guardarRequestStore(store) {
    fs.writeFileSync(REQUEST_STORE_FILE, JSON.stringify(store, null, 2));
}

function generarRequestId() {
    return `req_${crypto.randomBytes(12).toString('hex')}`;
}

function actualizarRequest(requestId, patch) {
    const store = leerRequestStore();
    store[requestId] = {
        ...(store[requestId] || {}),
        ...patch,
        updatedAt: new Date().toISOString()
    };
    guardarRequestStore(store);
    return store[requestId];
}

function obtenerRequest(requestId) {
    const store = leerRequestStore();
    return store[requestId] || null;
}

function obtenerMarcaDeTiempo(request = {}) {
    const value = request.updatedAt || request.createdAt;
    const timestamp = value ? Date.parse(value) : NaN;
    return Number.isNaN(timestamp) ? null : timestamp;
}

function obtenerPosicionEnCola(requestId) {
    const index = colaEspera.findIndex(item => item.requestId === requestId);
    return index >= 0 ? index + 1 : null;
}

function solicitudSigueViva(request = {}) {
    if (!request || !request.requestId) {
        return false;
    }

    if (request.status === 'processing') {
        return requestIdsActivos.has(request.requestId);
    }

    if (request.status === 'queued') {
        return obtenerPosicionEnCola(request.requestId) !== null;
    }

    return false;
}

function solicitudAtascada(request = {}) {
    if (!request || !['queued', 'processing'].includes(request.status)) {
        return false;
    }

    if (!solicitudSigueViva(request)) {
        return true;
    }

    const timestamp = obtenerMarcaDeTiempo(request);
    if (!timestamp) {
        return false;
    }

    const maxAge = request.status === 'queued' ? REQUEST_QUEUE_STALE_MS : REQUEST_PROCESSING_STALE_MS;
    return (Date.now() - timestamp) > maxAge;
}

function construirResultadoInterrumpido(requestId, request = {}, message) {
    return {
        success: false,
        error: message,
        requestId,
        roleId: request.roleId || null,
        packageKey: request.packageKey || null,
        retriable: true
    };
}

function marcarSolicitudInterrumpida(requestId, request = {}, message) {
    const result = construirResultadoInterrumpido(requestId, request, message);
    return actualizarRequest(requestId, {
        status: 'failed',
        queued: false,
        interrupted: true,
        result
    });
}

function limpiarSolicitudesInterrumpidas() {
    const store = leerRequestStore();
    let changed = false;

    for (const [requestId, request] of Object.entries(store)) {
        if (!['queued', 'processing'].includes(request?.status)) {
            continue;
        }

        store[requestId] = {
            ...request,
            status: 'failed',
            queued: false,
            interrupted: true,
            result: construirResultadoInterrumpido(
                requestId,
                request,
                'La solicitud anterior quedó interrumpida y debe reiniciarse desde cero.'
            ),
            updatedAt: new Date().toISOString()
        };
        changed = true;
    }

    if (changed) {
        guardarRequestStore(store);
    }
}

async function procesarCola() {
    while (colaEspera.length > 0 && tareasActivas < MAX_CONCURRENCIA) {
        const siguiente = colaEspera.shift();
        if (siguiente) {
            siguiente.run();
        }
    }
}

async function ejecutarCompraEnCola({ roleId, packageKey, requestId, res }) {
    tareasActivas++;
    requestIdsActivos.add(requestId);
    actualizarRequest(requestId, {
        requestId,
        roleId,
        packageKey: packageKey || null,
        status: 'processing',
        queued: false
    });

    try {
        const resultado = await ejecutarCompra({
            roleId,
            packageKey: packageKey || '',
            headless: true,
            keepBrowserOpen: false
        });

        actualizarRequest(requestId, {
            status: resultado.success ? 'completed' : 'failed',
            result: resultado
        });

        return res.status(resultado.success ? 200 : 500).json({
            ...resultado,
            requestId
        });
    } catch (error) {
        const payload = {
            success: false,
            error: error.message,
            requestId,
            roleId,
            packageKey: packageKey || null
        };
        actualizarRequest(requestId, {
            status: 'failed',
            result: payload
        });
        return res.status(500).json(payload);
    } finally {
        tareasActivas--;
        requestIdsActivos.delete(requestId);
        procesarCola();
    }
}

app.post('/comprar', async (req, res) => {
    const { roleId, paquete, packageKey, requestId: rawRequestId } = req.body || {};

    if (!roleId) {
        return res.status(400).json({ success: false, error: 'roleId es requerido' });
    }

    const finalPackageKey = packageKey || paquete || '';
    const requestId = rawRequestId || generarRequestId();
    const existente = obtenerRequest(requestId);

    if (existente) {
        if (existente.status === 'completed' && existente.result) {
            return res.status(200).json({
                ...existente.result,
                requestId,
                cached: true
            });
        }

        if (existente.status === 'processing' || existente.status === 'queued') {
            if (solicitudAtascada(existente)) {
                marcarSolicitudInterrumpida(
                    requestId,
                    existente,
                    'La solicitud anterior quedó atascada. Se reiniciará desde cero.'
                );
            } else {
                const queuePosition = existente.status === 'queued' ? obtenerPosicionEnCola(requestId) : null;
                return res.status(202).json({
                    success: true,
                    requestId,
                    status: existente.status,
                    queuePosition,
                    message: 'La solicitud ya está en proceso'
                });
            }
        }

        if (existente.status === 'failed') {
            console.log(`Reintentando solicitud fallida ${requestId} desde cero`);
        }

        if (existente.result && existente.status !== 'failed') {
            return res.status(202).json({
                ...existente.result,
                requestId,
                cached: true
            });
        }
    }

    actualizarRequest(requestId, {
        requestId,
        roleId,
        packageKey: finalPackageKey || null,
        status: tareasActivas < MAX_CONCURRENCIA ? 'processing' : 'queued',
        queued: tareasActivas >= MAX_CONCURRENCIA,
        interrupted: false,
        attempts: (existente?.attempts || 0) + 1,
        createdAt: new Date().toISOString()
    });

    const ejecutar = () => ejecutarCompraEnCola({
        roleId,
        packageKey: finalPackageKey,
        requestId,
        res
    });

    if (tareasActivas < MAX_CONCURRENCIA) {
        return ejecutar();
    }

    colaEspera.push({ requestId, run: ejecutar });
    return res.status(202).json({
        success: true,
        requestId,
        status: 'queued',
        queuePosition: colaEspera.length
    });
});

app.post('/mapear', async (req, res) => {
    const { roleId } = req.body || {};

    try {
        const resultado = await mapearPaquetes(roleId, {
            headless: true,
            keepBrowserOpen: false
        });
        return res.status(resultado.success ? 200 : 500).json(resultado);
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

app.get('/requests/:requestId', (req, res) => {
    const item = obtenerRequest(req.params.requestId);
    if (!item) {
        return res.status(404).json({ success: false, error: 'requestId no encontrado' });
    }

    return res.json({ success: true, ...item });
});

app.get('/status', (req, res) => {
    res.json({
        status: 'online',
        environment: IS_PRODUCTION ? 'production' : 'development',
        tareasActivas,
        enCola: colaEspera.length,
        solicitudesActivas: Array.from(requestIdsActivos),
        maxConcurrencia: MAX_CONCURRENCIA,
        paquetes_disponibles: Object.keys(DEFAULT_PACKAGES)
    });
});

app.get('/paquetes', (req, res) => {
    res.json(DEFAULT_PACKAGES);
});

limpiarSolicitudesInterrumpidas();

app.listen(PORT, () => {
    console.log('='.repeat(50));
    console.log('🚀 Servidor de compras Blood Strike');
    console.log(`📡 Escuchando en http://localhost:${PORT}`);
    console.log(`🔒 Modo: headless | Concurrencia: ${MAX_CONCURRENCIA} | Entorno: ${IS_PRODUCTION ? 'production' : 'development'}`);
    console.log('='.repeat(50));
    console.log('\n📖 Endpoints disponibles:');
    console.log('   POST /comprar  - { roleId: "123", packageKey: "bs_xxx", requestId: "abc" }');
    console.log('   POST /mapear   - { roleId: "123" }');
    console.log('   GET  /requests/:id - Estado de una solicitud');
    console.log('   GET  /status   - Estado del servidor');
    console.log('   GET  /paquetes - Lista base de paquetes\n');
});
