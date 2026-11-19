import crypto from 'node:crypto';

/**
 * Realtime fan-out over Server-Sent Events.
 *
 * SSE was chosen over WebSockets because the traffic is strictly server → client
 * (scan events, alerts, occupancy) and it survives proxies without an upgrade
 * handshake. Each subscriber carries the user's resolved permission set, so a
 * channel is only ever delivered to clients that are allowed to read it — the
 * stream endpoint is gated by the same `requirePermission` middleware as REST.
 */

/** channel -> permission needed to receive it (any one of `permissions`). */
export const CHANNEL_PERMISSIONS = {
  scan: ['attendance:read', 'dashboard:read'],
  activity: ['attendance:read', 'dashboard:read'],
  alert: ['alerts:read'],
  alerts: ['alerts:read'],
  fleet: ['fleet:read'],
  occupancy: ['fleet:read', 'dashboard:read'],
  dashboard: ['dashboard:read'],
  visitor: ['attendance:read', 'dashboard:read'],
  users: ['users:read'],
  // CRUD fan-out. Each carries the read permission of its own module so a
  // principal who cannot list the entity never hears about its changes.
  students: ['students:read', 'dashboard:read'],
  buses: ['fleet:read'],
  routes: ['fleet:read'],
  // Trip selections are student records: read them with the roster, or with
  // attendance when a campus only holds the scan/reporting set.
  bookings: ['students:read', 'attendance:read', 'dashboard:read'],
};

const HEARTBEAT_MS = 25_000;

class RealtimeHub {
  constructor() {
    /** @type {Map<string, {id:string,res:import('express').Response,userId:number|null,email:string|null,roleKey:string|null,tenantId:string|null,permissions:Set<string>,channels:Set<string>,connectedAt:number}>} */
    this.clients = new Map();
    this.heartbeat = null;
    this.sequence = 0;
  }

  /**
   * Is this subscriber entitled to `channel`?
   *
   * A rider holds no staff permissions at all by design (see `ROLE_DEFAULTS`
   * for `student`), so every fan-out channel denies them — they are addressed
   * only through `sendToUser`, which carries their own rows and needs no
   * channel entitlement. That keeps one student's booking out of another
   * student's stream even though both share the connection.
   *
   * `eventTenant` additionally filters by campus: a campus subscriber only
   * ever hears its own campus's events plus campus-neutral (system) ones, so
   * one college's live board never displays another college's scans, alerts or
   * roster changes. A platform subscriber (no tenant) hears everything — they
   * govern the whole platform.
   */
  canReceive(client, channel, eventTenant = null) {
    if (client.roleKey === 'student') return false;
    const required = CHANNEL_PERMISSIONS[channel];
    const entitled = required
      ? required.some((permission) => client.permissions.has(permission))
      : client.permissions.has('dashboard:read');
    if (!entitled) return false;
    if (client.tenantId != null && eventTenant != null && client.tenantId !== eventTenant) return false;
    return true;
  }

  /**
   * Attach an Express response as an SSE stream. Returns the subscriber id.
   * The caller is responsible for having already verified the request.
   */
  subscribe(req, res, user) {
    const id = crypto.randomUUID();
    const permissions = new Set(user?.permissions ?? []);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Ask the browser to retry quickly if the stream drops.
    res.write('retry: 3000\n\n');

    this.clients.set(id, {
      id,
      res,
      userId: user?.id ?? null,
      email: user?.email ?? null,
      roleKey: user?.role_key ?? user?.roleKey ?? null,
      // Campus tenancy of the subscriber: NULL means a platform principal
      // (governs every campus); otherwise only this campus's events are fanned
      // out. See `canReceive`.
      tenantId: user?.tenant_id ?? null,
      permissions,
      channels: new Set(),
      connectedAt: Date.now(),
    });

    this.sendTo(id, 'connected', {
      subscriberId: id,
      channels: Object.keys(CHANNEL_PERMISSIONS).filter((channel) => this.canReceive(this.clients.get(id), channel)),
      serverTime: new Date().toISOString(),
    });

    const cleanup = () => this.unsubscribe(id);
    req.on('close', cleanup);
    req.on('aborted', cleanup);
    res.on('error', cleanup);

    this.ensureHeartbeat();
    return id;
  }

  sendTo(id, event, data) {
    const client = this.clients.get(id);
    if (!client) return false;
    try {
      this.sequence += 1;
      client.res.write(`id: ${this.sequence}\n`);
      client.res.write(`event: ${event}\n`);
      client.res.write(`data: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch {
      this.unsubscribe(id);
      return false;
    }
  }

  /**
   * Push an event to every subscriber entitled to `channel`.
   *
   * The event's campus is the explicit `tenantId` argument when given,
   * otherwise `payload.tenantId` / `payload.tenant_id` when the payload carries
   * one, otherwise NULL (a campus-neutral event every campus receives).
   * @param {string} channel  one of CHANNEL_PERMISSIONS
   * @param {string} event    client-side event name, e.g. 'scan'
   * @param {object} payload  JSON-serialisable body
   * @param {string|null} [tenantId] campus this event belongs to, when the payload does not carry one
   */
  broadcast(channel, event, payload, tenantId) {
    const eventTenant = tenantId !== undefined ? (tenantId ?? null) : (payload?.tenantId ?? payload?.tenant_id ?? null);
    let delivered = 0;
    for (const client of this.clients.values()) {
      if (!this.canReceive(client, channel, eventTenant)) continue;
      if (this.sendTo(client.id, event, { channel, ...payload })) delivered += 1;
    }
    return delivered;
  }

  /** Broadcast to a single user only — used for personal session events. */
  sendToUser(userId, event, payload) {
    let delivered = 0;
    for (const client of this.clients.values()) {
      if (client.userId !== Number(userId)) continue;
      if (this.sendTo(client.id, event, payload)) delivered += 1;
    }
    return delivered;
  }

  unsubscribe(id) {
    const client = this.clients.get(id);
    if (!client) return;
    this.clients.delete(id);
    try {
      client.res.end();
    } catch {
      /* already closed */
    }
    if (this.clients.size === 0 && this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  ensureHeartbeat() {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      const payload = `event: heartbeat\ndata: ${JSON.stringify({ t: Date.now() })}\n\n`;
      for (const client of [...this.clients.values()]) {
        try {
          client.res.write(payload);
        } catch {
          this.unsubscribe(client.id);
        }
      }
    }, HEARTBEAT_MS);
    // Never hold the process open just for heartbeats.
    this.heartbeat.unref?.();
  }

  stats() {
    const byPermission = {};
    for (const client of this.clients.values()) {
      for (const permission of client.permissions) {
        byPermission[permission] = (byPermission[permission] ?? 0) + 1;
      }
    }
    return {
      subscribers: this.clients.size,
      byChannel: Object.fromEntries(
        Object.keys(CHANNEL_PERMISSIONS).map((channel) => [
          channel,
          [...this.clients.values()].filter((client) => this.canReceive(client, channel)).length,
        ]),
      ),
      byPermission,
      sequence: this.sequence,
    };
  }

  closeAll() {
    for (const id of [...this.clients.keys()]) this.unsubscribe(id);
  }
}

export const hub = new RealtimeHub();

export default hub;
