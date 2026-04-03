const { loadEnvFile } = require('./env-loader');
loadEnvFile();

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
    cerrarPersistentRuntime,
    ejecutarCompra,
    ensurePersistentRuntime,
    mapearPaquetes,
    obtenerEstadoPersistentRuntime
} = require('./comprar');

const app = express();
app.use(express.json());

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT || (IS_PRODUCTION ? 5005 : 5006));
const MAX_CONCURRENCIA = 1;
const REQUEST_STORE_FILE = path.join(__dirname, 'game-request-store.json');
const DEFAULT_PACKAGES = {
    '50_gold': { goodsid: 'g83naxx1ena.USD.gold50.ally', goodsinfo: '50 barras de oro' },
    '100_gold': { goodsid: 'g83naxx1ena.USD.gold100.ally', goodsinfo: '100 barras de oro' },
    '300_gold': { goodsid: 'g83naxx1ena.USD.gold300.ally', goodsinfo: '300 barras de oro' },
    '500_gold': { goodsid: 'g83naxx1ena.USD.gold500.ally', goodsinfo: '500 barras de oro' },
    '1000_gold': { goodsid: 'g83naxx1ena.USD.gold1000.ally', goodsinfo: '1000 barras de oro' }
};

let tareasActivas = 0;
const colaEspera = [];

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

function procesarCola() {
    while (colaEspera.length > 0 && tareasActivas < MAX_CONCURRENCIA) {
        const siguiente = colaEspera.shift();
        if (siguiente) {
            siguiente();
        }
    }
}

async function ejecutarCompraEnCola({ roleId, packageKey, requestId, res }) {
    tareasActivas++;
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
            keepBrowserOpen: false,
            persistentSession: true
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
        if (existente.status === 'processing' || existente.status === 'queued') {
            return res.status(202).json({
                success: true,
                requestId,
                status: existente.status,
                message: 'La solicitud ya está en proceso'
            });
        }

        if (existente.result) {
            return res.status(existente.status === 'completed' ? 200 : 500).json({
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

    colaEspera.push(ejecutar);
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
            keepBrowserOpen: false,
            persistentSession: true
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

app.post('/warmup', async (req, res) => {
    try {
        await ensurePersistentRuntime({ headless: true, keepBrowserOpen: true });
        return res.json({ success: true, runtime: obtenerEstadoPersistentRuntime() });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message, runtime: obtenerEstadoPersistentRuntime() });
    }
});

app.post('/reset-runtime', async (req, res) => {
    try {
        await cerrarPersistentRuntime();
        await ensurePersistentRuntime({ headless: true, keepBrowserOpen: true });
        return res.json({ success: true, runtime: obtenerEstadoPersistentRuntime() });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message, runtime: obtenerEstadoPersistentRuntime() });
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
        maxConcurrencia: MAX_CONCURRENCIA,
        runtime: obtenerEstadoPersistentRuntime(),
        paquetes_disponibles: Object.keys(DEFAULT_PACKAGES)
    });
});

app.get('/paquetes', (req, res) => {
    res.json(DEFAULT_PACKAGES);
});

app.listen(PORT, async () => {
    console.log('='.repeat(50));
    console.log('🚀 Servidor de compras Blood Strike');
    console.log(`📡 Escuchando en http://localhost:${PORT}`);
    console.log(`🔒 Modo: headless | Concurrencia: ${MAX_CONCURRENCIA} | Entorno: ${IS_PRODUCTION ? 'production' : 'development'}`);
    console.log('='.repeat(50));
    console.log('\n📖 Endpoints disponibles:');
    console.log('   POST /comprar  - { roleId: "123", packageKey: "bs_xxx", requestId: "abc" }');
    console.log('   POST /mapear   - { roleId: "123" }');
    console.log('   POST /warmup   - Precalienta login y sesión persistente');
    console.log('   POST /reset-runtime - Reinicia la sesión persistente');
    console.log('   GET  /requests/:id - Estado de una solicitud');
    console.log('   GET  /status   - Estado del servidor');
    console.log('   GET  /paquetes - Lista base de paquetes\n');

    try {
        await ensurePersistentRuntime({ headless: true, keepBrowserOpen: true });
        console.log('🔥 Sesión persistente precalentada y lista para compras');
    } catch (error) {
        console.error(`⚠️ No se pudo precalentar la sesión persistente: ${error.message}`);
    }
});
