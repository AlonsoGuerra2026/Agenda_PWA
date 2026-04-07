// ═══════════════════════════════════════════════════════════════
// SERVICE WORKER — Agenda Personal & Laboral v3 PWA
// Versión: 3.0.0
// Maneja: Cache offline, Notificaciones push, Alarmas en background
// ═══════════════════════════════════════════════════════════════

const SW_VERSION    = '3.0.0';
const CACHE_NAME    = 'agenda-v3-cache-' + SW_VERSION;
const ALARM_DB_NAME = 'agenda-alarms';

// Archivos a cachear para funcionamiento offline
const CACHE_FILES = [
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable.png',
];

// ── INSTALACIÓN ──────────────────────────────────────────────
self.addEventListener('install', event => {
  console.log('[SW] Instalando versión', SW_VERSION);
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // Cachear archivos locales (los externos como Google Fonts pueden fallar, se ignoran)
      return Promise.allSettled(
        CACHE_FILES.map(f => cache.add(f).catch(e => console.warn('[SW] No se pudo cachear:', f, e)))
      );
    }).then(() => self.skipWaiting())
  );
});

// ── ACTIVACIÓN ───────────────────────────────────────────────
self.addEventListener('activate', event => {
  console.log('[SW] Activando versión', SW_VERSION);
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => {
          console.log('[SW] Eliminando cache antiguo:', k);
          return caches.delete(k);
        })
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH (Offline First para archivos locales) ───────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Solo interceptar archivos del mismo origen (no Google Fonts, etc.)
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Cachear respuestas válidas dinámicamente
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Si falla la red y no hay cache, devolver el index para modo offline
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});

// ═══════════════════════════════════════════════════════════════
// SISTEMA DE ALARMAS EN SEGUNDO PLANO
// ═══════════════════════════════════════════════════════════════

// Tabla de alarmas programadas: Map<alarmId, { actId, titulo, fecha, hora, modo, prioridad, notas, catIcon, duracion }>
const pendingAlarms = new Map();
let alarmCheckInterval = null;

// ── RECIBIR MENSAJE DE LA APP ─────────────────────────────────
self.addEventListener('message', event => {
  const { type, payload } = event.data || {};

  switch (type) {

    case 'SCHEDULE_ALARMS':
      // La app envía todas las alarmas pendientes al SW
      scheduleAlarms(payload.alarms);
      break;

    case 'CANCEL_ALARM':
      cancelAlarm(payload.alarmId);
      break;

    case 'CANCEL_ALL_ALARMS':
      cancelAllAlarms();
      break;

    case 'TEST_NOTIFICATION':
      showTestNotification(payload);
      break;

    case 'APP_OPEN':
      // La app acaba de abrirse, pausar alarmas del SW (la app las maneja)
      stopAlarmCheck();
      break;

    case 'APP_CLOSED':
      // La app se cerró, el SW toma el control de las alarmas
      startAlarmCheck(payload.alarms);
      break;

    case 'SYNC_ALARMS':
      // Sincronizar lista de alarmas activas
      startAlarmCheck(payload.alarms);
      break;
  }
});

// ── PROGRAMAR ALARMAS ─────────────────────────────────────────
function scheduleAlarms(alarms) {
  if (!alarms || !Array.isArray(alarms)) return;
  pendingAlarms.clear();
  alarms.forEach(alarm => {
    if (!alarm.notified && !alarm.done && alarm.hora) {
      pendingAlarms.set(alarm.id, alarm);
    }
  });
  console.log('[SW] Alarmas programadas:', pendingAlarms.size);
}

function cancelAlarm(alarmId) {
  pendingAlarms.delete(alarmId);
}

function cancelAllAlarms() {
  pendingAlarms.clear();
  stopAlarmCheck();
}

// ── BUCLE DE VERIFICACIÓN ─────────────────────────────────────
function startAlarmCheck(alarms) {
  if (alarms) scheduleAlarms(alarms);
  stopAlarmCheck(); // evitar duplicados
  alarmCheckInterval = setInterval(checkPendingAlarms, 30000); // cada 30 segundos
  checkPendingAlarms(); // verificar inmediatamente
  console.log('[SW] Bucle de alarmas iniciado');
}

function stopAlarmCheck() {
  if (alarmCheckInterval) {
    clearInterval(alarmCheckInterval);
    alarmCheckInterval = null;
  }
}

function checkPendingAlarms() {
  if (pendingAlarms.size === 0) return;

  const now    = new Date();
  const today  = now.toISOString().slice(0, 10);
  const nowMin = now.getHours() * 60 + now.getMinutes();

  pendingAlarms.forEach((alarm, id) => {
    if (alarm.done || alarm.fecha !== today) return;

    const [h, m] = alarm.hora.split(':').map(Number);
    const actMin  = h * 60 + m;
    const aviso   = parseInt(alarm.aviso) || 10;
    const diff    = actMin - nowMin;

    // Disparar si estamos dentro del minuto del aviso
    if (diff <= aviso && diff > aviso - 1) {
      console.log('[SW] ¡Alarma disparada!', alarm.titulo);
      showAlarmNotification(alarm, diff);
      // Marcar como notificada para no repetir
      pendingAlarms.delete(id);
      // Notificar a la app si está abierta
      notifyClients({ type: 'ALARM_FIRED', alarmId: id });
    }
  });
}

// ── MOSTRAR NOTIFICACIÓN DE ALARMA ───────────────────────────
async function showAlarmNotification(alarm, minutesLeft) {
  const modeLabel = { p: '👤 Personal', l: '💼 Laboral', e: '🎓 Estudiantil' }[alarm.modo] || '📅 Agenda';
  const prioLabel = { alta: '🔴 Alta', media: '🟡 Media', baja: '🟢 Baja' }[alarm.prioridad] || '';
  const timeLabel = minutesLeft > 0 ? `en ${minutesLeft} minuto${minutesLeft !== 1 ? 's' : ''}` : '¡AHORA!';

  const title   = `${alarm.catIcon || '📅'} ${alarm.titulo}`;
  const body    = `⏰ ${timeLabel} — ${alarm.fecha}${alarm.hora ? ' · ' + alarm.hora : ''}\n${prioLabel} ${alarm.prioridad || ''}${alarm.notas ? '\n📝 ' + alarm.notas : ''}`;
  const tag     = 'alarm-' + alarm.id;
  const icon    = './icons/icon-192.png';
  const badge   = './icons/icon-192.png';

  const options = {
    body,
    tag,
    icon,
    badge,
    vibrate: [200, 100, 200, 100, 200],
    requireInteraction: true,          // No desaparece sola en Android
    renotify: true,
    silent: false,
    data: {
      alarmId: alarm.id,
      actId:   alarm.actId,
      modo:    alarm.modo,
      url:     self.registration.scope + 'index.html',
    },
    actions: [
      { action: 'ok',     title: '✓ Entendido' },
      { action: 'snooze', title: '⏱ +5 min'   },
      { action: 'done',   title: '✅ Completar' },
    ],
  };

  try {
    await self.registration.showNotification(`🔔 ${modeLabel} — Recordatorio`, options);
    // Notificación con subtítulo del título de la actividad
    await self.registration.showNotification(title, {
      ...options,
      tag: tag + '_detail',
      requireInteraction: false,
      actions: [],
    });
  } catch (e) {
    console.error('[SW] Error mostrando notificación:', e);
  }
}

// ── NOTIFICACIÓN DE PRUEBA ────────────────────────────────────
async function showTestNotification(payload) {
  await self.registration.showNotification('🔔 Prueba de Alarma — Agenda', {
    body: '✅ Las notificaciones funcionan correctamente en segundo plano.',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    vibrate: [300, 100, 300],
    tag: 'test-notif',
    data: { url: self.registration.scope + 'index.html' },
  });
}

// ── CLIC EN NOTIFICACIÓN ──────────────────────────────────────
self.addEventListener('notificationclick', event => {
  const { action, notification } = event;
  const data = notification.data || {};

  notification.close();

  event.waitUntil((async () => {
    // Abrir o enfocar la app
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const appClient = clients.find(c => c.url.includes('index.html')) || clients[0];

    if (action === 'snooze') {
      // Reprogramar la alarma 5 minutos más tarde
      const alarm = pendingAlarms.get(data.alarmId);
      if (alarm) {
        const [h, m] = alarm.hora.split(':').map(Number);
        const snoozeMin = h * 60 + m + 5;
        alarm.hora = `${String(Math.floor(snoozeMin / 60)).padStart(2, '0')}:${String(snoozeMin % 60).padStart(2, '0')}`;
        pendingAlarms.set(data.alarmId, alarm);
      }
      if (appClient) appClient.postMessage({ type: 'SNOOZE', alarmId: data.alarmId });
      return;
    }

    if (action === 'done') {
      if (appClient) appClient.postMessage({ type: 'MARK_DONE', actId: data.actId });
      return;
    }

    // Acción por defecto: abrir/enfocar la app
    if (appClient) {
      appClient.focus();
      appClient.postMessage({ type: 'OPEN_FROM_NOTIF', actId: data.actId });
    } else {
      await self.clients.openWindow(data.url || './index.html');
    }
  })());
});

// ── NOTIFICACIÓN CERRADA ──────────────────────────────────────
self.addEventListener('notificationclose', event => {
  console.log('[SW] Notificación cerrada:', event.notification.tag);
});

// ── BACKGROUND SYNC (para cuando vuelve la conexión) ─────────
self.addEventListener('sync', event => {
  if (event.tag === 'check-alarms') {
    event.waitUntil(checkPendingAlarms());
  }
});

// ── PERIODIC BACKGROUND SYNC (Chrome Android) ────────────────
self.addEventListener('periodicsync', event => {
  if (event.tag === 'alarm-check') {
    event.waitUntil(checkPendingAlarms());
  }
});

// ── HELPER: NOTIFICAR A CLIENTES ABIERTOS ────────────────────
async function notifyClients(message) {
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach(client => client.postMessage(message));
}

console.log('[SW] Service Worker cargado. Versión:', SW_VERSION);
