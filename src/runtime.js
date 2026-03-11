import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { launchOptions } from 'camoufox-js';
import { firefox } from 'playwright-core';

import {
  annotateAriaYamlWithRefs,
  buildRefsFromAriaYaml,
  formatDomFallbackRefs,
  isValidRoleRef,
  shouldSkipDomCandidateByName,
  sliceSnapshot
} from './snapshot.js';

function nowIso() {
  return new Date().toISOString();
}

function sanitizeFileName(value) {
  return String(value || 'file')
    .replace(/[\\/<>:"|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 180);
}

function clipString(value, max = 2048) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function shortHash(value) {
  return crypto
    .createHash('sha1')
    .update(String(value || ''))
    .digest('hex')
    .slice(0, 16);
}

function buildTargetHandle(info) {
  if (!info) return null;
  if (info.strategy === 'selector' && info.selector) {
    return `h_${shortHash(`selector|${info.selector}`)}`;
  }

  const role = normalizeWhitespace(info.role).toLowerCase();
  const name = normalizeWhitespace(info.name).toLowerCase();
  const nth = Number.parseInt(info.nth ?? '0', 10) || 0;
  if (role || name) {
    return `h_${shortHash(`role|${role}|${name}|${nth}`)}`;
  }

  return `h_${shortHash(JSON.stringify(info))}`;
}

function parseMimeType(contentType) {
  if (!contentType) return '';
  return contentType.split(';')[0].trim().toLowerCase();
}

function shouldCaptureBody(contentType) {
  const mime = parseMimeType(contentType);
  if (!mime) return false;
  if (mime.includes('json')) return true;
  if (mime.startsWith('text/')) return true;
  if (mime.includes('xml')) return true;
  if (mime.includes('javascript')) return true;
  return false;
}

function isBlankPageUrl(url) {
  const value = String(url || '').toLowerCase();
  return value === '' || value === 'about:blank' || value === 'about:newtab' || value === 'chrome://new-tab-page/' || value === 'data:,';
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const v = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

function parseAuthMode(value, fallback = 'shared') {
  const v = normalizeWhitespace(value).toLowerCase();
  if (v === 'isolated') return 'isolated';
  if (v === 'shared') return 'shared';
  return fallback;
}

function parseOnProfileBusy(value, fallback = 'reuse') {
  const v = normalizeWhitespace(value).toLowerCase();
  if (v === 'reuse') return 'reuse';
  if (v === 'handoff') return 'handoff';
  if (v === 'error') return 'error';
  return fallback;
}

export class BrowserRuntime {
  constructor(config) {
    this.config = config;

    this.sharedBrowser = null;
    this.sharedBrowserPromise = null;

    this.sessions = new Map();
    this.tabs = new Map();
    this.tabLocks = new Map();
    this.profileLocks = new Map();

    this.eventSeq = 1;

    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredSessions().catch(() => {});
    }, 60_000);
    this.cleanupInterval.unref();
  }

  async init() {
    await fs.mkdir(this.config.dataDir, { recursive: true });
    await fs.mkdir(this.config.profilesDir, { recursive: true });
    await fs.mkdir(this.config.artifactsDir, { recursive: true });
    await fs.mkdir(this.config.logsDir, { recursive: true });
  }

  health() {
    return {
      ok: true,
      engine: 'camoufox',
      sessions: this.sessions.size,
      tabs: this.tabs.size,
      sharedBrowserConnected: Boolean(this.sharedBrowser?.isConnected?.())
    };
  }

  capabilities() {
    return {
      provider: 'camoufox',
      features: {
        persistentSessions: true,
        networkEvents: true,
        downloads: true,
        responseBodyCapture: true,
        authenticatedFetch: true,
        accessibilitySnapshotRefs: true,
        domFallbackRefs: true,
        htmlSnapshot: true,
        clickByText: true,
        forceClick: true,
        dispatchClick: true,
        setField: true,
        selectOption: true,
        chooseMenuItem: true,
        retryPolicies: true,
        handles: true,
        inspect: true,
        query: true,
        evaluate: true,
        actionsV1: true,
        actionKinds: ['click', 'dispatchClick', 'clickText', 'type', 'setField', 'select', 'chooseMenuItem', 'press', 'scroll', 'wait', 'hover', 'focus', 'clear', 'check', 'uncheck', 'drag', 'upload'],
        waitPredicates: ['domcontentloaded', 'networkidle', 'text', 'goneText', 'url', 'urlContains', 'selector'],
        sharedProfileAuth: true,
        profileBusyBehavior: ['reuse', 'handoff', 'error']
      }
    };
  }

  listSessions() {
    return [...this.sessions.values()].map((session) => this.serializeSession(session));
  }

  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      const err = new Error(`Session not found: ${sessionId}`);
      err.statusCode = 404;
      throw err;
    }
    return session;
  }

  getTab(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      const err = new Error(`Tab not found: ${tabId}`);
      err.statusCode = 404;
      throw err;
    }
    return tab;
  }

  getTabInfo(tabId) {
    const tab = this.getTab(tabId);
    const base = this.serializeTab(tab);
    return {
      ...base,
      url: tab.page.url()
    };
  }

  async createSession(options = {}) {
    const sessionId = options.sessionId || crypto.randomUUID();
    if (this.sessions.has(sessionId)) {
      const err = new Error(`Session already exists: ${sessionId}`);
      err.statusCode = 409;
      throw err;
    }

    const persistent = options.persistent !== false;
    const authMode = persistent
      ? parseAuthMode(options.authMode, 'shared')
      : 'ephemeral';

    const requestedProfileName = normalizeWhitespace(options.profileName);
    const profileName = persistent
      ? (requestedProfileName || (authMode === 'shared' ? 'main' : sessionId))
      : null;

    const onProfileBusy = persistent
      ? parseOnProfileBusy(options.onProfileBusy, authMode === 'shared' ? 'reuse' : 'error')
      : 'error';

    const headless = options.headless ?? this.config.headless;

    if (persistent) {
      return this.withProfileLock(profileName, async () => {
        if (this.sessions.has(sessionId)) {
          const err = new Error(`Session already exists: ${sessionId}`);
          err.statusCode = 409;
          throw err;
        }

        return this.createPersistentSession({
          sessionId,
          authMode,
          profileName,
          onProfileBusy,
          headless
        });
      });
    }

    const browser = await this.ensureSharedBrowser();
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      acceptDownloads: true
    });

    const session = {
      id: sessionId,
      createdAt: nowIso(),
      lastAccessAt: Date.now(),
      persistent,
      authMode,
      profileName,
      profileDir: null,
      context,
      ownsBrowser: false,
      headless,
      tabs: new Map()
    };

    this.sessions.set(session.id, session);

    return this.serializeSession(session, { reused: false });
  }

  async createPersistentSession({ sessionId, authMode, profileName, onProfileBusy, headless }) {
    const existing = this.findPersistentSessionByProfile(profileName);
    if (existing) {
      if (authMode === 'shared' && onProfileBusy === 'reuse') {
        existing.lastAccessAt = Date.now();
        return this.serializeSession(existing, {
          reused: true,
          requestedHeadless: headless,
          requestedSessionId: sessionId
        });
      }

      if (authMode === 'shared' && onProfileBusy === 'handoff') {
        await this.closeSession(existing.id);
      } else {
        throw this.createProfileBusyError(profileName, existing.profileDir, existing.id);
      }
    }

    const profileDir = path.join(this.config.profilesDir, sanitizeFileName(profileName));
    await fs.mkdir(profileDir, { recursive: true });
    const launch = await this.buildCamoufoxLaunchOptions(headless);

    let context;
    try {
      context = await firefox.launchPersistentContext(profileDir, {
        ...launch,
        viewport: { width: 1440, height: 900 },
        acceptDownloads: true
      });
    } catch (error) {
      if (this.isLikelyProfileBusyLaunchError(error)) {
        throw this.createProfileBusyError(profileName, profileDir);
      }
      throw error;
    }

    const session = {
      id: sessionId,
      createdAt: nowIso(),
      lastAccessAt: Date.now(),
      persistent: true,
      authMode,
      profileName,
      profileDir,
      context,
      ownsBrowser: true,
      headless,
      tabs: new Map()
    };

    this.sessions.set(session.id, session);

    return this.serializeSession(session, { reused: false });
  }

  async closeSession(sessionId) {
    const session = this.getSession(sessionId);

    for (const tabId of [...session.tabs.keys()]) {
      await this.closeTab(tabId).catch(() => {});
    }

    await session.context.close().catch(() => {});
    this.sessions.delete(sessionId);

    return { ok: true, sessionId };
  }

  async addCookies(sessionId, cookies = []) {
    const session = this.getSession(sessionId);
    if (!Array.isArray(cookies)) {
      const err = new Error('cookies must be an array');
      err.statusCode = 400;
      throw err;
    }

    const sanitized = [];
    for (const cookie of cookies) {
      if (!cookie || typeof cookie !== 'object') continue;
      if (!cookie.name || (!cookie.domain && !cookie.url)) continue;

      const item = {
        name: String(cookie.name),
        value: String(cookie.value ?? ''),
        path: cookie.path ? String(cookie.path) : '/'
      };

      if (cookie.domain) item.domain = String(cookie.domain);
      if (cookie.url) item.url = String(cookie.url);
      if (cookie.expires !== undefined && cookie.expires !== null) item.expires = Number(cookie.expires);
      if (cookie.httpOnly !== undefined) item.httpOnly = Boolean(cookie.httpOnly);
      if (cookie.secure !== undefined) item.secure = Boolean(cookie.secure);
      if (cookie.sameSite !== undefined) item.sameSite = String(cookie.sameSite);

      sanitized.push(item);
    }

    await session.context.addCookies(sanitized);
    session.lastAccessAt = Date.now();

    return {
      ok: true,
      sessionId,
      imported: sanitized.length
    };
  }

  async getCookies(sessionId, urls = []) {
    const session = this.getSession(sessionId);
    const cookies = await session.context.cookies(urls);
    session.lastAccessAt = Date.now();

    return {
      sessionId,
      count: cookies.length,
      cookies
    };
  }

  async createTab(sessionId, payload = {}) {
    const session = this.getSession(sessionId);
    session.lastAccessAt = Date.now();

    const managedPages = new Set([...session.tabs.values()].map((t) => t.page));
    let page = null;

    // Persistent contexts often start with a blank bootstrap tab.
    // Reuse it instead of opening a second window/tab.
    for (const candidate of session.context.pages()) {
      if (managedPages.has(candidate)) continue;
      if (candidate.isClosed()) continue;
      if (isBlankPageUrl(candidate.url())) {
        page = candidate;
        break;
      }
    }

    if (!page) {
      page = await session.context.newPage();
    }

    const tabId = payload.tabId || crypto.randomUUID();
    if (this.tabs.has(tabId)) {
      if (!managedPages.has(page)) {
        await page.close().catch(() => {});
      }
      const err = new Error(`Tab already exists: ${tabId}`);
      err.statusCode = 409;
      throw err;
    }

    const tabArtifactsDir = path.join(this.config.artifactsDir, 'sessions', session.id, 'tabs', tabId);
    const tabLogsDir = path.join(this.config.logsDir, 'sessions', session.id, 'tabs', tabId);
    await fs.mkdir(tabArtifactsDir, { recursive: true });
    await fs.mkdir(tabLogsDir, { recursive: true });

    const tab = {
      id: tabId,
      sessionId: session.id,
      page,
      createdAt: nowIso(),
      refs: new Map(),
      handleHints: new Map(),
      lastSnapshot: '',
      events: [],
      requestIds: new WeakMap(),
      requestSeq: 1,
      downloadSeq: 1,
      downloads: [],
      artifactsDir: tabArtifactsDir,
      networkLogPath: path.join(tabLogsDir, 'network.jsonl')
    };

    this.attachTabObservers(tab);

    session.tabs.set(tabId, tab);
    this.tabs.set(tabId, tab);

    if (payload.url) {
      await this.navigateTab(tabId, payload.url);
    }

    return this.serializeTab(tab);
  }

  async closeTab(tabId) {
    const tab = this.getTab(tabId);
    const session = this.getSession(tab.sessionId);

    await tab.page.close().catch(() => {});

    session.tabs.delete(tabId);
    this.tabs.delete(tabId);
    this.tabLocks.delete(tabId);

    return { ok: true, tabId };
  }

  listTabs(sessionId) {
    const session = this.getSession(sessionId);
    session.lastAccessAt = Date.now();
    return [...session.tabs.values()].map((tab) => this.serializeTab(tab));
  }

  async navigateTab(tabId, url) {
    const tab = this.getTab(tabId);
    const session = this.getSession(tab.sessionId);
    session.lastAccessAt = Date.now();

    await this.withTabLock(tabId, async () => {
      await tab.page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: this.config.tabActionTimeoutMs
      });
      tab.refs.clear();
      tab.lastSnapshot = '';
    });

    return {
      ok: true,
      tabId,
      url: tab.page.url()
    };
  }

  async inspectTab(tabId, payload = {}) {
    const tab = this.getTab(tabId);
    const session = this.getSession(tab.sessionId);
    session.lastAccessAt = Date.now();

    const offset = Math.max(0, Number.parseInt(payload.offset ?? '0', 10) || 0);
    const limit = Math.min(Math.max(Number.parseInt(payload.limit ?? '200', 10) || 200, 1), 1000);
    const includeDom = parseBool(payload.includeDom, false);
    const includeScreenshot = parseBool(payload.includeScreenshot, false);
    const domOffset = Math.max(0, Number.parseInt(payload.domOffset ?? '0', 10) || 0);

    let targetItems = [];

    await this.withTabLock(tabId, async () => {
      await this.refreshRefs(tab);

      targetItems = [...tab.refs.entries()].map(([ref, info]) => ({
        ref,
        handle: info.handle,
        source: info.source,
        strategy: info.strategy,
        role: info.role || null,
        name: info.name || null,
        text: info.text || null,
        selector: info.selector || null,
        nth: Number.parseInt(info.nth ?? '0', 10) || 0
      }));
    });

    const total = targetItems.length;
    const end = Math.min(total, offset + limit);
    const pageItems = targetItems.slice(offset, end);

    const enriched = [];
    for (const item of pageItems) {
      try {
        const resolved = await this.resolveLocator(tab, {
          ref: item.ref
        });
        const locator = resolved.locator.first();
        const stats = await locator.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          const visible = Boolean(
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            style.opacity !== '0'
          );
          const enabled = !('disabled' in element) || !element.disabled;
          return {
            visible,
            enabled,
            bbox: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height
            }
          };
        });

        enriched.push({
          ...item,
          ...stats
        });
      } catch {
        enriched.push({
          ...item,
          visible: null,
          enabled: null,
          bbox: null
        });
      }
    }

    const pageState = await tab.page.evaluate(() => ({
      url: window.location.href,
      title: document.title || '',
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      }
    }));

    let screenshot;
    if (includeScreenshot) {
      const png = await tab.page.screenshot({ type: 'png' });
      screenshot = {
        mimeType: 'image/png',
        data: png.toString('base64')
      };
    }

    let dom;
    if (includeDom) {
      const html = await tab.page.content().catch(() => '');
      dom = sliceSnapshot(html, domOffset, this.config.maxDomChars);
    }

    return {
      tabId,
      sessionId: tab.sessionId,
      page: pageState,
      targets: enriched,
      pageInfo: {
        total,
        offset,
        limit,
        returned: enriched.length,
        hasMore: end < total,
        nextOffset: end
      },
      dom,
      screenshot
    };
  }

  async queryTab(tabId, payload = {}) {
    const tab = this.getTab(tabId);
    const session = this.getSession(tab.sessionId);
    session.lastAccessAt = Date.now();

    const target = payload.target || {};
    const filters = payload.filters || {};
    const offset = Math.max(0, Number.parseInt(payload.offset ?? '0', 10) || 0);
    const limit = Math.min(Math.max(Number.parseInt(payload.limit ?? '50', 10) || 50, 1), 500);

    await this.withTabLock(tabId, async () => {
      if (!tab.refs.size) {
        await this.refreshRefs(tab);
      }
    });

    const targetPayload = this.targetPayloadFromTarget(target);
    const { locator, target: resolvedTarget } = await this.resolveLocator(tab, targetPayload);

    const totalMatches = await locator.count().catch(() => 0);
    const end = Math.min(totalMatches, offset + limit);

    const matches = [];
    for (let i = offset; i < end; i += 1) {
      const entryLocator = locator.nth(i);

      try {
        const meta = await entryLocator.evaluate((element) => {
          const toText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
          const role = toText(element.getAttribute('role')).toLowerCase() || null;
          const name =
            toText(element.getAttribute('aria-label')) ||
            toText(element.getAttribute('title')) ||
            toText(element.getAttribute('placeholder')) ||
            toText(element.innerText || element.textContent || '') ||
            null;
          const text = toText(element.innerText || element.textContent || '') || null;
          const tag = element.tagName.toLowerCase();
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          const visible = Boolean(
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            style.opacity !== '0'
          );
          const enabled = !('disabled' in element) || !element.disabled;

          const buildSelector = () => {
            if (element.id) return `#${element.id}`;
            const parts = [];
            let node = element;
            while (node && node instanceof Element && parts.length < 7) {
              let seg = node.tagName.toLowerCase();
              const parent = node.parentElement;
              if (parent) {
                const same = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
                if (same.length > 1) seg += `:nth-of-type(${same.indexOf(node) + 1})`;
              }
              parts.unshift(seg);
              node = parent;
            }
            return parts.join(' > ');
          };

          return {
            role,
            name,
            text,
            tag,
            selector: buildSelector(),
            visible,
            enabled,
            bbox: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height
            }
          };
        });

        if (filters.visible === true && !meta.visible) continue;
        if (filters.enabled === true && !meta.enabled) continue;

        const handle = buildTargetHandle({
          strategy: 'selector',
          selector: meta.selector,
          role: meta.role,
          name: meta.name,
          nth: i
        });

        const refEntry = [...tab.refs.entries()].find(([, info]) => info.handle === handle);

        matches.push({
          index: i,
          ref: refEntry ? refEntry[0] : null,
          handle,
          ...meta
        });
      } catch {
        // skip unstable match
      }
    }

    return {
      tabId,
      sessionId: tab.sessionId,
      query: {
        target,
        filters,
        resolvedTarget
      },
      matches,
      pageInfo: {
        total: totalMatches,
        offset,
        limit,
        returned: matches.length,
        hasMore: end < totalMatches,
        nextOffset: end
      }
    };
  }

  async waitTab(tabId, payload = {}) {
    const tab = this.getTab(tabId);
    const session = this.getSession(tab.sessionId);
    session.lastAccessAt = Date.now();

    const mode = normalizeWhitespace(payload.mode || 'all').toLowerCase() === 'any' ? 'any' : 'all';
    const timeoutMs = Math.max(1, Number.parseInt(payload.timeoutMs ?? this.config.tabActionTimeoutMs, 10) || this.config.tabActionTimeoutMs);
    const conditions = Array.isArray(payload.conditions) ? payload.conditions : [];

    if (!conditions.length) {
      const err = new Error('conditions[] is required');
      err.statusCode = 400;
      err.code = 'BAD_WAIT_REQUEST';
      throw err;
    }

    const start = Date.now();

    const runCondition = async (condition) => {
      const normalized = this.waitConditionToLegacyPayload(condition, timeoutMs);
      await this.waitForTabCondition(tab, normalized);
      return {
        condition,
        ok: true,
        elapsedMs: Date.now() - start
      };
    };

    let matched = [];

    await this.withTabLock(tabId, async () => {
      if (mode === 'all') {
        for (const condition of conditions) {
          const result = await runCondition(condition);
          matched.push(result);
        }
      } else {
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => {
            const err = new Error('Wait condition timed out');
            err.statusCode = 408;
            err.code = 'WAIT_TIMEOUT';
            reject(err);
          }, timeoutMs);
        });

        const conditionPromises = conditions.map((condition, idx) =>
          runCondition(condition).then((result) => ({ idx, result }))
        );

        try {
          const winner = await Promise.race([
            timeoutPromise,
            Promise.any(conditionPromises)
          ]);
          matched = [winner.result];
        } catch (error) {
          if (error?.name === 'AggregateError') {
            const err = new Error('No wait condition was satisfied');
            err.statusCode = 408;
            err.code = 'WAIT_CONDITIONS_FAILED';
            throw err;
          }
          throw error;
        }
      }
    });

    return {
      ok: true,
      tabId,
      sessionId: tab.sessionId,
      mode,
      matched,
      elapsedMs: Date.now() - start,
      url: tab.page.url()
    };
  }

  async evalTab(tabId, payload = {}) {
    const tab = this.getTab(tabId);
    const session = this.getSession(tab.sessionId);
    session.lastAccessAt = Date.now();

    const script = String(payload.script || '').trim();
    if (!script) {
      const err = new Error('script is required');
      err.statusCode = 400;
      err.code = 'BAD_EVAL_REQUEST';
      throw err;
    }

    const args = payload.args ?? null;
    const timeoutMs = Math.max(1, Number.parseInt(payload.timeoutMs ?? this.config.tabActionTimeoutMs, 10) || this.config.tabActionTimeoutMs);
    const target = payload.target ? this.targetPayloadFromTarget(payload.target) : null;

    let result;
    let resolvedTarget = null;

    await this.withTabLock(tabId, async () => {
      if (target) {
        const resolved = await this.resolveLocator(tab, target);
        resolvedTarget = resolved.target;
        result = await resolved.locator.evaluate((element, input) => {
          const fn = (0, eval)(`(${input.script})`);
          if (typeof fn === 'function') {
            return fn(element, input.args);
          }
          return fn;
        }, { script, args }, { timeout: timeoutMs });
      } else {
        result = await tab.page.evaluate((input) => {
          const fn = (0, eval)(`(${input.script})`);
          if (typeof fn === 'function') {
            return fn(input.args);
          }
          return fn;
        }, { script, args }, { timeout: timeoutMs });
      }
    });

    return {
      ok: true,
      tabId,
      sessionId: tab.sessionId,
      resolvedTarget,
      result,
      url: tab.page.url()
    };
  }

  async snapshotTab(tabId, options = {}) {
    const tab = this.getTab(tabId);
    const session = this.getSession(tab.sessionId);
    session.lastAccessAt = Date.now();

    const offset = Number.parseInt(options.offset ?? '0', 10) || 0;
    const domOffset = Number.parseInt(options.domOffset ?? '0', 10) || 0;
    const domRefOffset = Number.parseInt(options.domRefOffset ?? '0', 10) || 0;
    const domRefLimit = Number.parseInt(options.domRefLimit ?? `${this.config.maxDomFallbackRefs}`, 10) || this.config.maxDomFallbackRefs;
    const includeDom = parseBool(options.includeDom, false);

    let annotated = '';
    let domFallbackRefs = [];
    let domFallbackSection = {
      text: '',
      total: 0,
      offset: domRefOffset,
      limit: domRefLimit,
      returned: 0,
      hasMore: false,
      nextOffset: domRefOffset
    };

    await this.withTabLock(tabId, async () => {
      const refreshed = await this.refreshRefs(tab);
      domFallbackRefs = refreshed.domOnlyRefs;

      annotated = annotateAriaYamlWithRefs(refreshed.aria || '', refreshed.refs);
      domFallbackSection = formatDomFallbackRefs(domFallbackRefs, {
        offset: domRefOffset,
        limit: domRefLimit
      });
      if (domFallbackSection.text) {
        annotated = `${annotated}${domFallbackSection.text}`;
      }

      tab.lastSnapshot = annotated;
    });

    const sliced = sliceSnapshot(annotated, offset, this.config.maxSnapshotChars);

    let screenshot;
    if (options.includeScreenshot) {
      const png = await tab.page.screenshot({ type: 'png' });
      screenshot = {
        mimeType: 'image/png',
        data: png.toString('base64')
      };
    }

    let dom;
    if (includeDom) {
      const html = await tab.page.content().catch(() => '');
      dom = sliceSnapshot(html, domOffset, this.config.maxDomChars);
    }

    return {
      tabId,
      sessionId: tab.sessionId,
      url: tab.page.url(),
      refsCount: tab.refs.size,
      ariaRefsCount: [...tab.refs.values()].filter((info) => info.source === 'aria').length,
      domFallbackRefsCount: domFallbackRefs.length,
      domFallbackRefs,
      domFallbackRefsPage: {
        total: domFallbackSection.total,
        offset: domFallbackSection.offset,
        limit: domFallbackSection.limit,
        returned: domFallbackSection.returned,
        hasMore: domFallbackSection.hasMore,
        nextOffset: domFallbackSection.nextOffset
      },
      ...sliced,
      dom,
      screenshot
    };
  }

  async actTab(tabId, payload = {}) {
    const action = normalizeWhitespace(payload.action).toLowerCase();
    if (!action) {
      const err = new Error('action is required');
      err.statusCode = 400;
      err.code = 'BAD_ACTION_REQUEST';
      throw err;
    }

    const actionMap = {
      click: 'click',
      dispatchclick: 'dispatchClick',
      clicktext: 'clickText',
      type: 'type',
      setfield: 'setField',
      select: 'selectOption',
      selectoption: 'selectOption',
      choosemenuitem: 'chooseMenuItem',
      press: 'press',
      scroll: 'scroll',
      wait: 'wait',
      hover: 'hover',
      focus: 'focus',
      clear: 'clear',
      check: 'check',
      uncheck: 'uncheck',
      drag: 'drag',
      upload: 'upload'
    };

    const kind = actionMap[action];
    if (!kind) {
      const err = new Error(`Unsupported action: ${payload.action}`);
      err.statusCode = 400;
      err.code = 'UNSUPPORTED_ACTION';
      throw err;
    }

    const legacy = {
      kind,
      retry: payload.retry || undefined
    };

    Object.assign(legacy, this.targetPayloadFromTarget(payload.target || {}));

    const input = payload.input || {};
    const options = payload.options || {};

    // generic option passthrough
    Object.assign(legacy, options);

    if (kind === 'type') {
      legacy.text = input.text ?? input.value ?? '';
      legacy.submit = parseBool(input.submit, false);
    } else if (kind === 'setField') {
      if (!legacy.label && !legacy.ref && !legacy.handle && !legacy.selector) {
        legacy.label = String(input.label || '');
      }
      legacy.value = input.value ?? input.text ?? '';
      legacy.text = legacy.value;
      legacy.submit = parseBool(input.submit, false);
    } else if (kind === 'clickText') {
      legacy.text = String(input.text ?? payload.target?.text ?? '');
      legacy.exact = parseBool(input.exact ?? payload.target?.exact, true);
      legacy.nth = input.nth ?? payload.target?.nth;
    } else if (kind === 'press') {
      legacy.key = String(input.key || '');
    } else if (kind === 'selectOption') {
      legacy.optionText = String(input.optionText ?? input.text ?? '');
      legacy.exactOption = parseBool(input.exactOption ?? input.exact, true);
      legacy.optionNth = input.optionNth ?? input.nth;
      if (input.openOnly !== undefined) legacy.openOnly = parseBool(input.openOnly, false);
    } else if (kind === 'chooseMenuItem') {
      legacy.itemText = String(input.itemText ?? input.text ?? '');
      legacy.itemNth = input.itemNth ?? input.nth;
      legacy.exactItem = parseBool(input.exactItem ?? input.exact, true);
      if (input.openOnly !== undefined) legacy.openOnly = parseBool(input.openOnly, false);
      if (input.triggerText) legacy.triggerText = String(input.triggerText);
      if (input.triggerTarget) {
        const trigger = this.targetPayloadFromTarget(input.triggerTarget);
        Object.assign(legacy, {
          triggerRef: trigger.ref,
          triggerHandle: trigger.handle,
          triggerSelector: trigger.selector,
          triggerLabel: trigger.label,
          triggerRole: trigger.role,
          triggerName: trigger.name,
          triggerTargetText: trigger.text,
          triggerExactName: trigger.exactName,
          triggerExact: trigger.exact,
          triggerNth: trigger.nth
        });
      }
    } else if (kind === 'scroll') {
      if (input.amount !== undefined) legacy.amount = input.amount;
      if (input.dy !== undefined) legacy.dy = input.dy;
      if (input.direction) legacy.direction = input.direction;
    } else if (kind === 'wait') {
      Object.assign(legacy, this.waitConditionToLegacyPayload(input.condition || payload.wait || input, options.timeoutMs));
    } else if (kind === 'drag') {
      const toTarget = input.toTarget || payload.toTarget || null;
      if (toTarget) {
        Object.assign(legacy, {
          toTarget: toTarget
        });
      }
    } else if (kind === 'upload') {
      legacy.files = input.files || input.filePaths || [];
    }

    const actionResult = await this.tabAction(tabId, legacy);

    if (payload.waitAfter && payload.waitAfter.conditions) {
      const waitResult = await this.waitTab(tabId, payload.waitAfter);
      return {
        ...actionResult,
        waitAfter: waitResult
      };
    }

    return actionResult;
  }

  async tabAction(tabId, payload = {}) {
    const tab = this.getTab(tabId);
    const session = this.getSession(tab.sessionId);
    session.lastAccessAt = Date.now();

    const kind = payload.kind;
    if (!kind) {
      const err = new Error('kind is required');
      err.statusCode = 400;
      throw err;
    }

    const retryPolicy = this.parseRetryPolicy(payload.retry, payload);
    const trace = {
      kind,
      retryPolicy,
      attempts: []
    };

    await this.withTabLock(tabId, async () => {
      let lastError = null;

      for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt += 1) {
        const attemptTrace = {
          attempt,
          ok: false
        };

        try {
          await this.runTabActionOnce(tab, payload, attemptTrace);
          attemptTrace.ok = true;
          trace.attempts.push(attemptTrace);
          lastError = null;
          break;
        } catch (error) {
          const decorated = this.decorateActionError(error, { kind, payload });
          attemptTrace.error = {
            code: decorated.code || 'UNKNOWN_ERROR',
            message: decorated.message
          };
          trace.attempts.push(attemptTrace);
          lastError = decorated;

          const canRetry = this.shouldRetryAction(decorated, retryPolicy, attempt);
          if (!canRetry) break;

          if (decorated.code === 'STALE_REF' || decorated.code === 'STALE_HANDLE') {
            await this.refreshRefs(tab).catch(() => {});
          }

          const backoff = Math.max(0, retryPolicy.backoffMs) * attempt;
          if (backoff > 0) await tab.page.waitForTimeout(backoff);
        }
      }

      if (lastError) {
        lastError.actionTrace = trace;
        this.recordEvent(tab, {
          kind: 'action',
          action: kind,
          ok: false,
          errorCode: lastError.code || 'ACTION_ERROR',
          errorMessage: lastError.message,
          trace
        });
        throw lastError;
      }

      await tab.page.waitForTimeout(200);
      tab.lastSnapshot = '';

      this.recordEvent(tab, {
        kind: 'action',
        action: kind,
        ok: true,
        trace,
        url: tab.page.url()
      });
    });

    return {
      ok: true,
      tabId,
      url: tab.page.url(),
      trace
    };
  }

  targetPayloadFromTarget(target = {}) {
    const spec = target && typeof target === 'object' ? target : {};
    const by = normalizeWhitespace(spec.by).toLowerCase();

    if (by === 'ref' || (!by && spec.ref)) {
      return { ref: String(spec.ref) };
    }
    if (by === 'handle' || (!by && spec.handle)) {
      return { handle: String(spec.handle) };
    }
    if (by === 'selector' || (!by && spec.selector)) {
      return { selector: String(spec.selector) };
    }
    if (by === 'label' || (!by && spec.label)) {
      return {
        label: String(spec.label),
        exactLabel: parseBool(spec.exact, false),
        nth: spec.nth
      };
    }
    if (by === 'role' || (!by && spec.role)) {
      return {
        role: String(spec.role),
        name: spec.name,
        exactName: parseBool(spec.exact, false),
        nth: spec.nth
      };
    }
    if (by === 'text' || (!by && spec.text)) {
      return {
        text: String(spec.text),
        exact: parseBool(spec.exact, true),
        nth: spec.nth
      };
    }

    return {};
  }

  waitConditionToLegacyPayload(condition = {}, timeoutMs = this.config.tabActionTimeoutMs) {
    const item = condition && typeof condition === 'object' ? condition : {};
    const kind = normalizeWhitespace(item.kind).toLowerCase();
    const value = item.value;

    if (kind === 'sleep') {
      return { ms: Number(item.ms ?? value ?? 0), timeoutMs };
    }
    if (kind === 'url') {
      return { url: String(value || item.url || ''), timeoutMs };
    }
    if (kind === 'urlcontains') {
      return { urlContains: String(value || item.urlContains || ''), timeoutMs };
    }
    if (kind === 'networkidle') {
      return { networkIdle: true, timeoutMs };
    }
    if (kind === 'selector') {
      return {
        selector: String(value || item.selector || ''),
        state: item.state,
        timeoutMs
      };
    }
    if (kind === 'textpresent') {
      return {
        text: String(value || item.text || ''),
        exact: parseBool(item.exact, false),
        timeoutMs
      };
    }
    if (kind === 'textgone') {
      return {
        goneText: String(value || item.text || ''),
        exactGoneText: parseBool(item.exact, false),
        timeoutMs
      };
    }

    // fallback to direct legacy-compatible payload
    return {
      ...item,
      timeoutMs
    };
  }

  parseRetryPolicy(retryPayload = {}, actionPayload = {}) {
    const input = retryPayload && typeof retryPayload === 'object' ? retryPayload : {};

    const maxAttemptsRaw = Number.parseInt(
      input.maxAttempts ?? actionPayload.maxAttempts ?? '1',
      10
    );
    const maxAttempts = Math.min(Math.max(Number.isFinite(maxAttemptsRaw) ? maxAttemptsRaw : 1, 1), 6);

    const backoffRaw = Number.parseInt(
      input.backoffMs ?? actionPayload.retryBackoffMs ?? '150',
      10
    );
    const backoffMs = Number.isFinite(backoffRaw) ? Math.max(0, backoffRaw) : 150;

    const defaultRetryOn = ['ELEMENT_INTERCEPTED', 'STALE_REF', 'STALE_HANDLE', 'TARGET_NOT_FOUND', 'NOT_VISIBLE'];
    const retryOnRaw = input.on ?? actionPayload.retryOn;
    let retryOn;
    if (Array.isArray(retryOnRaw)) {
      retryOn = retryOnRaw.map((value) => normalizeWhitespace(value).toUpperCase()).filter(Boolean);
    } else if (typeof retryOnRaw === 'string') {
      retryOn = retryOnRaw.split(',').map((value) => normalizeWhitespace(value).toUpperCase()).filter(Boolean);
    } else {
      retryOn = defaultRetryOn;
    }

    return { maxAttempts, backoffMs, retryOn };
  }

  shouldRetryAction(error, retryPolicy, attempt) {
    if (!retryPolicy || attempt >= retryPolicy.maxAttempts) return false;
    const code = normalizeWhitespace(error?.code).toUpperCase();
    if (!code) return false;
    return retryPolicy.retryOn.includes(code);
  }

  async runTabActionOnce(tab, payload, attemptTrace = {}) {
    const kind = payload.kind;

    if (kind === 'click') {
      const { locator, target } = await this.resolveLocator(tab, payload);
      attemptTrace.target = target;
      await this.clickLocator(locator, payload);
      return;
    }

    if (kind === 'dispatchClick') {
      let locator;
      if (payload.text) {
        locator = this.locatorByVisibleText(tab, payload.text, {
          exact: parseBool(payload.exact, true),
          nth: payload.nth
        });
        attemptTrace.target = {
          resolvedBy: 'text',
          text: normalizeWhitespace(payload.text),
          exact: parseBool(payload.exact, true),
          nth: Math.max(0, Number.parseInt(payload.nth ?? '0', 10) || 0)
        };
      } else {
        const resolved = await this.resolveLocator(tab, payload);
        locator = resolved.locator;
        attemptTrace.target = resolved.target;
      }
      await this.dispatchClickLocator(locator);
      return;
    }

    if (kind === 'clickText') {
      const locator = this.locatorByVisibleText(tab, payload.text, {
        exact: parseBool(payload.exact, true),
        nth: payload.nth
      });
      attemptTrace.target = {
        resolvedBy: 'text',
        text: normalizeWhitespace(payload.text),
        exact: parseBool(payload.exact, true),
        nth: Math.max(0, Number.parseInt(payload.nth ?? '0', 10) || 0)
      };
      await this.clickLocator(locator, payload);
      return;
    }

    if (kind === 'type' || kind === 'setField') {
      const { locator, target } = await this.resolveLocator(tab, payload);
      attemptTrace.target = target;
      await locator.fill(String(payload.text ?? payload.value ?? ''), { timeout: this.config.tabActionTimeoutMs });
      if (payload.submit) await tab.page.keyboard.press('Enter');
      return;
    }

    if (kind === 'selectOption') {
      attemptTrace.target = await this.selectOption(tab, payload);
      return;
    }

    if (kind === 'chooseMenuItem') {
      attemptTrace.target = await this.chooseMenuItem(tab, payload);
      return;
    }

    if (kind === 'press') {
      if (!payload.key) {
        const err = new Error('key is required for press');
        err.statusCode = 400;
        throw err;
      }
      attemptTrace.target = {
        resolvedBy: 'keyboard',
        key: String(payload.key)
      };
      await tab.page.keyboard.press(payload.key);
      return;
    }

    if (kind === 'scroll') {
      if (payload.ref || payload.selector || payload.handle || payload.label || payload.role || payload.text) {
        const { locator, target } = await this.resolveLocator(tab, payload);
        attemptTrace.target = target;
        await locator.scrollIntoViewIfNeeded({ timeout: this.config.tabActionTimeoutMs });
      } else {
        const amount = Number(payload.amount ?? payload.dy ?? 500);
        const direction = String(payload.direction || 'down').toLowerCase();
        const delta = direction === 'up' ? -amount : amount;
        attemptTrace.target = {
          resolvedBy: 'page',
          delta
        };
        await tab.page.mouse.wheel(0, delta);
      }
      return;
    }

    if (kind === 'hover') {
      const { locator, target } = await this.resolveLocator(tab, payload);
      attemptTrace.target = target;
      await locator.hover({ timeout: this.config.tabActionTimeoutMs });
      return;
    }

    if (kind === 'focus') {
      const { locator, target } = await this.resolveLocator(tab, payload);
      attemptTrace.target = target;
      await locator.focus({ timeout: this.config.tabActionTimeoutMs });
      return;
    }

    if (kind === 'clear') {
      const { locator, target } = await this.resolveLocator(tab, payload);
      attemptTrace.target = target;
      await locator.fill('', { timeout: this.config.tabActionTimeoutMs });
      return;
    }

    if (kind === 'check') {
      const { locator, target } = await this.resolveLocator(tab, payload);
      attemptTrace.target = target;
      await locator.check({ timeout: this.config.tabActionTimeoutMs, force: parseBool(payload.force, false) });
      return;
    }

    if (kind === 'uncheck') {
      const { locator, target } = await this.resolveLocator(tab, payload);
      attemptTrace.target = target;
      await locator.uncheck({ timeout: this.config.tabActionTimeoutMs, force: parseBool(payload.force, false) });
      return;
    }

    if (kind === 'drag') {
      const source = await this.resolveLocator(tab, payload);
      const destinationTarget = payload.toTarget ? this.targetPayloadFromTarget(payload.toTarget) : {
        ref: payload.toRef,
        handle: payload.toHandle,
        selector: payload.toSelector,
        label: payload.toLabel,
        role: payload.toRole,
        name: payload.toName,
        text: payload.toText,
        nth: payload.toNth,
        exact: payload.toExact
      };
      const destination = await this.resolveLocator(tab, destinationTarget);
      attemptTrace.target = {
        source: source.target,
        destination: destination.target
      };
      await source.locator.dragTo(destination.locator, {
        timeout: this.config.tabActionTimeoutMs
      });
      return;
    }

    if (kind === 'upload') {
      const { locator, target } = await this.resolveLocator(tab, payload);
      const files = Array.isArray(payload.files) ? payload.files : (payload.files ? [payload.files] : []);
      if (!files.length) {
        const err = new Error('files is required for upload');
        err.statusCode = 400;
        err.code = 'BAD_UPLOAD_REQUEST';
        throw err;
      }
      attemptTrace.target = {
        ...target,
        filesCount: files.length
      };
      await locator.setInputFiles(files, { timeout: this.config.tabActionTimeoutMs });
      return;
    }

    if (kind === 'wait') {
      await this.waitForTabCondition(tab, payload);
      return;
    }

    const err = new Error(`Unsupported action kind: ${kind}`);
    err.statusCode = 400;
    throw err;
  }

  async tabFetch(tabId, payload = {}) {
    const tab = this.getTab(tabId);
    const session = this.getSession(tab.sessionId);
    session.lastAccessAt = Date.now();

    const url = payload.url;
    if (!url) {
      const err = new Error('url is required');
      err.statusCode = 400;
      throw err;
    }

    const method = String(payload.method || 'GET').toUpperCase();
    const headers = payload.headers || {};
    const maxBytes = Number(payload.maxBytes || this.config.maxCapturedBodyBytes);
    const responseType = String(payload.responseType || 'text').toLowerCase();

    const response = await tab.page.request.fetch(url, {
      method,
      headers,
      data: payload.body,
      timeout: this.config.tabActionTimeoutMs
    });

    const buffer = await response.body();
    const clipped = buffer.length > maxBytes ? buffer.subarray(0, maxBytes) : buffer;
    const truncated = buffer.length > maxBytes;

    let body;
    if (responseType === 'base64') {
      body = clipped.toString('base64');
    } else {
      const text = clipped.toString('utf8');
      if (responseType === 'json') {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      } else {
        body = text;
      }
    }

    const responseHeaders = typeof response.allHeaders === 'function'
      ? await response.allHeaders()
      : response.headers();

    return {
      ok: true,
      request: { method, url },
      response: {
        status: response.status(),
        ok: response.ok(),
        url: response.url(),
        headers: responseHeaders,
        bytes: buffer.length,
        truncated,
        body
      }
    };
  }

  listEvents(tabId, query = {}) {
    const tab = this.getTab(tabId);
    const since = Number.parseInt(query.since ?? query.cursor ?? '0', 10) || 0;
    const limit = Math.min(Number.parseInt(query.limit ?? '200', 10) || 200, 5000);

    let events = tab.events.filter((event) => event.seq > since);

    if (query.kind) {
      const kinds = new Set(String(query.kind).split(',').map((v) => v.trim()).filter(Boolean));
      events = events.filter((event) => kinds.has(event.kind));
    }

    if (query.urlContains) {
      const needle = String(query.urlContains);
      events = events.filter((event) => String(event.url || '').includes(needle));
    }

    const sliced = events.slice(0, limit);
    const nextCursor = sliced.length > 0 ? sliced[sliced.length - 1].seq : since;

    return {
      tabId,
      totalBuffered: tab.events.length,
      returned: sliced.length,
      nextCursor,
      events: sliced
    };
  }

  listNetworkEvents(tabId, query = {}) {
    const raw = this.listEvents(tabId, query);
    const networkKinds = new Set([
      'request',
      'response',
      'request_failed',
      'request_finished',
      'response_body_saved',
      'response_body_error'
    ]);

    const events = raw.events.filter((event) => networkKinds.has(event.kind));
    const nextCursor = events.length > 0 ? events[events.length - 1].seq : (Number.parseInt(query.since ?? query.cursor ?? '0', 10) || 0);

    return {
      ...raw,
      returned: events.length,
      nextCursor,
      events
    };
  }

  listDownloads(tabId) {
    const tab = this.getTab(tabId);
    return {
      tabId,
      downloads: tab.downloads
    };
  }

  async saveDownload(tabId, downloadId, outputPath) {
    const tab = this.getTab(tabId);
    const item = tab.downloads.find((d) => d.downloadId === downloadId);
    if (!item) {
      const err = new Error(`Download not found: ${downloadId}`);
      err.statusCode = 404;
      throw err;
    }
    if (!item.savedPath) {
      const err = new Error(`Download has no saved artifact path yet: ${downloadId}`);
      err.statusCode = 409;
      throw err;
    }

    const finalPath = path.resolve(outputPath);
    await fs.mkdir(path.dirname(finalPath), { recursive: true });
    await fs.copyFile(item.savedPath, finalPath);

    return {
      ok: true,
      tabId,
      downloadId,
      sourcePath: item.savedPath,
      outputPath: finalPath
    };
  }

  async close() {
    for (const sessionId of [...this.sessions.keys()]) {
      await this.closeSession(sessionId).catch(() => {});
    }

    if (this.sharedBrowser) {
      await this.sharedBrowser.close().catch(() => {});
      this.sharedBrowser = null;
    }

    clearInterval(this.cleanupInterval);
  }

  // Internal helpers

  findPersistentSessionByProfile(profileName) {
    if (!profileName) return null;
    for (const session of this.sessions.values()) {
      if (!session.persistent) continue;
      if (session.profileName !== profileName) continue;
      return session;
    }
    return null;
  }

  isLikelyProfileBusyLaunchError(error) {
    const message = String(error?.message || '').toLowerCase();
    if (!message) return false;
    if (!message.includes('failed to launch the browser process')) return false;
    if (message.includes('exitcode=0')) return true;
    if (message.includes('profile') && message.includes('juggler')) return true;
    return false;
  }

  createProfileBusyError(profileName, profileDir, activeSessionId = null) {
    const details = [];
    if (activeSessionId) details.push(`activeSessionId=${activeSessionId}`);
    if (profileDir) details.push(`profileDir=${profileDir}`);
    const suffix = details.length ? ` (${details.join(', ')})` : '';

    const err = new Error(
      `Profile "${profileName}" is already in use${suffix}. ` +
      'Reuse the active session, request onProfileBusy="handoff", or choose another profileName.'
    );
    err.statusCode = 409;
    err.code = 'PROFILE_BUSY';
    return err;
  }

  serializeSession(session, extra = {}) {
    const payload = {
      id: session.id,
      createdAt: session.createdAt,
      persistent: session.persistent,
      authMode: session.authMode || (session.persistent ? 'shared' : 'ephemeral'),
      profileName: session.profileName,
      profileDir: session.profileDir,
      headless: session.headless,
      tabs: session.tabs.size,
      lastAccessAt: new Date(session.lastAccessAt).toISOString()
    };

    for (const [key, value] of Object.entries(extra || {})) {
      if (value === undefined) continue;
      payload[key] = value;
    }

    return payload;
  }

  serializeTab(tab) {
    return {
      id: tab.id,
      sessionId: tab.sessionId,
      createdAt: tab.createdAt,
      url: tab.page.url(),
      refsCount: tab.refs.size,
      bufferedEvents: tab.events.length,
      downloads: tab.downloads.length
    };
  }

  async buildCamoufoxLaunchOptions(headless) {
    const options = await launchOptions({
      headless,
      os: this.config.os,
      humanize: this.config.humanize,
      enable_cache: this.config.enableCache
    });

    return options;
  }

  async ensureSharedBrowser() {
    if (this.sharedBrowser?.isConnected?.()) return this.sharedBrowser;
    if (this.sharedBrowserPromise) return this.sharedBrowserPromise;

    this.sharedBrowserPromise = (async () => {
      const launch = await this.buildCamoufoxLaunchOptions(this.config.headless);
      const browser = await firefox.launch(launch);
      this.sharedBrowser = browser;
      return browser;
    })().finally(() => {
      this.sharedBrowserPromise = null;
    });

    return this.sharedBrowserPromise;
  }

  async withTabLock(tabId, operation) {
    const prev = this.tabLocks.get(tabId) || Promise.resolve();
    const next = prev.then(() => operation(), () => operation());
    this.tabLocks.set(tabId, next.catch(() => {}));
    return next;
  }

  async withProfileLock(profileName, operation) {
    const key = profileName || '__default__';
    const prev = this.profileLocks.get(key) || Promise.resolve();

    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });

    this.profileLocks.set(key, gate);
    await prev.catch(() => {});

    try {
      return await operation();
    } finally {
      release();
      if (this.profileLocks.get(key) === gate) {
        this.profileLocks.delete(key);
      }
    }
  }

  mergeAriaAndDomRefs(ariaRefs, domCandidates) {
    const refs = new Map(ariaRefs);
    let nextRefIndex = refs.size + 1;

    const ariaRoleName = new Set();
    for (const info of refs.values()) {
      info.handle = buildTargetHandle(info);
      const role = normalizeWhitespace(info.role).toLowerCase();
      const name = normalizeWhitespace(info.name).toLowerCase();
      if (role && name) ariaRoleName.add(`${role}|${name}`);
    }

    const domOnlyRefs = [];

    for (const candidate of domCandidates) {
      if (domOnlyRefs.length >= this.config.maxDomFallbackRefs) break;

      const selector = normalizeWhitespace(candidate.selector);
      if (!selector) continue;

      const role = normalizeWhitespace(candidate.role).toLowerCase();
      const name = normalizeWhitespace(candidate.name || candidate.text);

      if (shouldSkipDomCandidateByName(name)) continue;

      const signature = role && name ? `${role}|${name.toLowerCase()}` : null;
      if (signature && ariaRoleName.has(signature)) continue;

      const ref = `e${nextRefIndex++}`;
      const info = {
        source: 'dom',
        strategy: 'selector',
        selector,
        role: role || undefined,
        name: name || '',
        tag: normalizeWhitespace(candidate.tag).toLowerCase() || undefined,
        text: normalizeWhitespace(candidate.text || '')
      };
      info.handle = buildTargetHandle(info);

      refs.set(ref, info);
      domOnlyRefs.push({ ref, ...info });
    }

    return { refs, domOnlyRefs };
  }

  async refreshRefs(tab) {
    const aria = await tab.page.locator('body').ariaSnapshot({ timeout: 8000 }).catch(() => '');
    const ariaRefs = buildRefsFromAriaYaml(aria || '');
    const domCandidates = await this.collectDomInteractiveCandidates(tab.page);
    const merged = this.mergeAriaAndDomRefs(ariaRefs, domCandidates);
    tab.refs = merged.refs;

    const nextHints = new Map();
    for (const info of merged.refs.values()) {
      const handle = info.handle || buildTargetHandle(info);
      if (!handle) continue;
      nextHints.set(handle, {
        source: info.source,
        strategy: info.strategy,
        selector: info.selector,
        role: info.role,
        name: info.name,
        nth: info.nth,
        tag: info.tag,
        text: info.text
      });
    }
    tab.handleHints = nextHints;

    return {
      aria,
      ...merged
    };
  }

  async collectDomInteractiveCandidates(page) {
    const maxCandidates = Math.max(20, this.config.maxDomFallbackRefs * 4);

    const result = await page.evaluate((limit) => {
      const toText = (value) => String(value || '').replace(/\s+/g, ' ').trim();

      const isVisible = (element) => {
        if (!element || !(element instanceof Element)) return false;
        if (element.hasAttribute('hidden')) return false;

        const style = window.getComputedStyle(element);
        if (!style) return false;
        if (style.visibility === 'hidden' || style.display === 'none') return false;
        if (style.opacity === '0') return false;

        const rect = element.getBoundingClientRect();
        if (!rect || rect.width < 1 || rect.height < 1) return false;

        return true;
      };

      const inferRole = (element) => {
        const explicitRole = toText(element.getAttribute('role')).toLowerCase();
        if (explicitRole) return explicitRole;

        const tag = element.tagName.toLowerCase();
        if (tag === 'button') return 'button';
        if (tag === 'a' && element.getAttribute('href')) return 'link';
        if (tag === 'textarea') return 'textbox';
        if (tag === 'select') return 'listbox';
        if (tag === 'summary') return 'button';

        if (tag === 'input') {
          const type = toText(element.getAttribute('type')).toLowerCase() || 'text';
          if (['button', 'submit', 'reset'].includes(type)) return 'button';
          if (type === 'checkbox') return 'checkbox';
          if (type === 'radio') return 'radio';
          return 'textbox';
        }

        return '';
      };

      const attrSelector = (attr, value) => {
        const escaped = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return `[${attr}="${escaped}"]`;
      };

      const cssEscape = (value) => {
        if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(String(value));
        return String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
      };

      const buildSelector = (element) => {
        if (!(element instanceof Element)) return '';

        if (element.id) return `#${cssEscape(element.id)}`;

        const preferredAttrs = ['data-testid', 'data-test', 'data-qa', 'name', 'aria-label', 'placeholder', 'title'];
        const tag = element.tagName.toLowerCase();
        for (const attr of preferredAttrs) {
          const value = element.getAttribute(attr);
          if (value) return `${tag}${attrSelector(attr, value)}`;
        }

        const parts = [];
        let node = element;

        while (node && node instanceof Element && parts.length < 7) {
          const currentTag = node.tagName.toLowerCase();
          let segment = currentTag;

          if (node.id) {
            segment = `#${cssEscape(node.id)}`;
            parts.unshift(segment);
            break;
          }

          const sameTagSiblings = node.parentElement
            ? Array.from(node.parentElement.children).filter((child) => child.tagName === node.tagName)
            : [];
          if (sameTagSiblings.length > 1) {
            segment += `:nth-of-type(${sameTagSiblings.indexOf(node) + 1})`;
          }

          parts.unshift(segment);
          node = node.parentElement;
        }

        return parts.join(' > ');
      };

      const candidateSet = new Set();
      const addCandidate = (element) => {
        if (element instanceof Element) candidateSet.add(element);
      };

      const baseSelector = [
        'button',
        'a[href]',
        'input:not([type="hidden"])',
        'textarea',
        'select',
        '[role]',
        '[tabindex]:not([tabindex="-1"])',
        '[contenteditable=""]',
        '[contenteditable="true"]',
        '[onclick]',
        'summary',
        '[data-testid]',
        '[data-test]',
        '[data-qa]'
      ].join(',');

      for (const node of document.querySelectorAll(baseSelector)) addCandidate(node);

      const allNodes = document.body ? Array.from(document.body.querySelectorAll('*')) : [];
      for (let i = 0; i < allNodes.length; i += 1) {
        const node = allNodes[i];
        if (!(node instanceof Element)) continue;
        const style = window.getComputedStyle(node);
        if (!style) continue;
        if (style.cursor === 'pointer') addCandidate(node);
      }

      const result = [];
      const seen = new Set();

      for (const element of candidateSet) {
        if (result.length >= limit) break;
        if (!isVisible(element)) continue;
        if (element.getAttribute('aria-hidden') === 'true') continue;

        const role = inferRole(element);

        let name =
          toText(element.getAttribute('aria-label')) ||
          toText(element.getAttribute('title')) ||
          toText(element.getAttribute('placeholder')) ||
          toText(element.getAttribute('alt')) ||
          toText(element.getAttribute('value'));

        if (!name && element instanceof HTMLInputElement && element.labels?.length) {
          name = toText(Array.from(element.labels).map((label) => label.textContent || '').join(' '));
        }

        if (!name && element.id) {
          const label = document.querySelector(`label[for="${cssEscape(element.id)}"]`);
          name = toText(label?.textContent || '');
        }

        const text = toText(element.innerText || element.textContent || '');
        if (!name) name = text;

        const selector = buildSelector(element);
        if (!selector) continue;

        const key = `${role}|${name}|${selector}`;
        if (seen.has(key)) continue;
        seen.add(key);

        result.push({
          role,
          name,
          text,
          tag: element.tagName.toLowerCase(),
          selector
        });
      }

      return result;
    }, maxCandidates);

    return Array.isArray(result) ? result : [];
  }

  locatorByVisibleText(tab, textInput, options = {}) {
    const text = normalizeWhitespace(textInput);
    if (!text) {
      const err = new Error('text is required');
      err.statusCode = 400;
      throw err;
    }

    const exact = parseBool(options.exact, true);
    const nth = Math.max(0, Number.parseInt(options.nth ?? '0', 10) || 0);

    return exact
      ? tab.page.getByText(text, { exact: true }).nth(nth)
      : tab.page.getByText(text).nth(nth);
  }

  async clickLocator(locator, options = {}) {
    const force = parseBool(options.force, false);
    const noWaitAfter = parseBool(options.noWaitAfter, false);

    const clickOptions = {
      timeout: this.config.tabActionTimeoutMs,
      force,
      noWaitAfter
    };

    if (options.button) clickOptions.button = String(options.button);

    const x = Number(options.positionX);
    const y = Number(options.positionY);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      clickOptions.position = { x, y };
    }

    if (!parseBool(options.skipScrollIntoView, false)) {
      await locator.scrollIntoViewIfNeeded({ timeout: this.config.tabActionTimeoutMs }).catch(() => {});
    }

    try {
      await locator.click(clickOptions);
    } catch (error) {
      if (parseBool(options.dispatchFallback, false) && this.isPointerInterceptError(error)) {
        await this.dispatchClickLocator(locator);
        return;
      }
      throw error;
    }
  }

  async dispatchClickLocator(locator) {
    await locator.evaluate((element) => {
      if (!element) return;
      if (typeof element.click === 'function') {
        element.click();
        return;
      }
      element.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window
      }));
    });
  }

  isPointerInterceptError(error) {
    const message = String(error?.message || '').toLowerCase();
    return message.includes('intercepts pointer events');
  }

  async selectOption(tab, payload = {}) {
    const optionText = normalizeWhitespace(payload.optionText || payload.text);
    if (!optionText) {
      const err = new Error('optionText (or text) is required for selectOption');
      err.statusCode = 400;
      throw err;
    }

    const exactOption = parseBool(payload.exactOption, parseBool(payload.exact, true));
    const optionNth = Math.max(0, Number.parseInt(payload.optionNth ?? payload.nth ?? '0', 10) || 0);

    let trigger = null;
    let triggerTarget = null;
    if (payload.ref || payload.selector || payload.handle || payload.label) {
      const resolved = await this.resolveLocator(tab, payload);
      trigger = resolved.locator;
      triggerTarget = resolved.target;

      const isNativeSelect = await trigger
        .evaluate((element) => element instanceof HTMLSelectElement)
        .catch(() => false);

      if (isNativeSelect) {
        const timeout = this.config.tabActionTimeoutMs;
        const optionIndex = Number.parseInt(payload.optionIndex ?? '-1', 10);
        const candidates = [];

        if (Number.isFinite(optionIndex) && optionIndex >= 0) {
          candidates.push({ index: optionIndex });
        }
        candidates.push({ label: optionText });
        candidates.push({ value: optionText });

        for (const candidate of candidates) {
          try {
            const selected = await trigger.selectOption(candidate, { timeout });
            if (Array.isArray(selected) && selected.length > 0) {
              return {
                trigger: triggerTarget,
                optionText,
                optionNth,
                exactOption,
                selectedBy: 'native-select'
              };
            }
          } catch {
            // try next candidate
          }
        }

        const err = new Error(`Option not found in native select: ${optionText}`);
        err.statusCode = 400;
        err.code = 'OPTION_NOT_FOUND';
        throw err;
      }

      await this.clickLocator(trigger, payload);
    }

    if (payload.openOnly) {
      return {
        trigger: triggerTarget,
        optionText,
        optionNth,
        exactOption,
        selectedBy: 'open-only'
      };
    }

    const clickOption = async (locator) => {
      await this.clickLocator(locator, {
        force: parseBool(payload.optionForce, payload.force),
        noWaitAfter: parseBool(payload.optionNoWaitAfter, payload.noWaitAfter),
        dispatchFallback: parseBool(payload.optionDispatchFallback, payload.dispatchFallback)
      });
    };

    const byRole = exactOption
      ? tab.page.getByRole('option', { name: optionText, exact: true }).nth(optionNth)
      : tab.page.getByRole('option', { name: optionText }).nth(optionNth);

    try {
      await clickOption(byRole);
      return {
        trigger: triggerTarget,
        optionText,
        optionNth,
        exactOption,
        selectedBy: 'role-option'
      };
    } catch {
      // fallback to text-based option selection below
    }

    const byText = exactOption
      ? tab.page.getByText(optionText, { exact: true }).nth(optionNth)
      : tab.page.getByText(optionText).nth(optionNth);

    await clickOption(byText);
    return {
      trigger: triggerTarget,
      optionText,
      optionNth,
      exactOption,
      selectedBy: 'text'
    };
  }

  async chooseMenuItem(tab, payload = {}) {
    const itemText = normalizeWhitespace(payload.itemText || payload.text);
    if (!itemText) {
      const err = new Error('itemText (or text) is required for chooseMenuItem');
      err.statusCode = 400;
      throw err;
    }

    const triggerPayload = {
      ref: payload.triggerRef ?? payload.ref,
      selector: payload.triggerSelector ?? payload.selector,
      handle: payload.triggerHandle ?? payload.handle,
      label: payload.triggerLabel ?? payload.label,
      role: payload.triggerRole,
      name: payload.triggerName,
      text: payload.triggerTargetText,
      exact: payload.triggerExact ?? payload.exact,
      exactName: payload.triggerExactName,
      nth: payload.triggerNth ?? payload.nth
    };

    let triggerTarget = null;
    if (triggerPayload.ref || triggerPayload.selector || triggerPayload.handle || triggerPayload.label || triggerPayload.role || triggerPayload.text) {
      const resolved = await this.resolveLocator(tab, triggerPayload);
      triggerTarget = resolved.target;
      await this.clickLocator(resolved.locator, payload);
    } else if (payload.triggerText) {
      const triggerLocator = this.locatorByVisibleText(tab, payload.triggerText, {
        exact: parseBool(payload.triggerExact, parseBool(payload.exact, true)),
        nth: payload.triggerNth
      });
      triggerTarget = {
        resolvedBy: 'text',
        text: normalizeWhitespace(payload.triggerText),
        exact: parseBool(payload.triggerExact, parseBool(payload.exact, true)),
        nth: Math.max(0, Number.parseInt(payload.triggerNth ?? '0', 10) || 0)
      };
      await this.clickLocator(triggerLocator, payload);
    }

    if (payload.openOnly) {
      return {
        trigger: triggerTarget,
        itemText,
        selectedBy: 'open-only'
      };
    }

    const exactItem = parseBool(payload.exactItem, parseBool(payload.exact, true));
    const itemNth = Math.max(0, Number.parseInt(payload.itemNth ?? '0', 10) || 0);

    const tryLocators = [
      exactItem
        ? tab.page.getByRole('menuitem', { name: itemText, exact: true }).nth(itemNth)
        : tab.page.getByRole('menuitem', { name: itemText }).nth(itemNth),
      exactItem
        ? tab.page.getByRole('option', { name: itemText, exact: true }).nth(itemNth)
        : tab.page.getByRole('option', { name: itemText }).nth(itemNth),
      exactItem
        ? tab.page.getByText(itemText, { exact: true }).nth(itemNth)
        : tab.page.getByText(itemText).nth(itemNth)
    ];

    let lastError = null;
    for (const locator of tryLocators) {
      try {
        await this.clickLocator(locator, {
          force: parseBool(payload.itemForce, payload.force),
          noWaitAfter: parseBool(payload.itemNoWaitAfter, payload.noWaitAfter),
          dispatchFallback: parseBool(payload.itemDispatchFallback, payload.dispatchFallback)
        });
        return {
          trigger: triggerTarget,
          itemText,
          itemNth,
          exactItem,
          selectedBy: locator === tryLocators[0]
            ? 'menuitem-role'
            : locator === tryLocators[1]
              ? 'option-role'
              : 'text'
        };
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error(`Menu item not found: ${itemText}`);
  }

  async waitForTabCondition(tab, payload = {}) {
    const timeout = Number.parseInt(payload.timeoutMs ?? this.config.tabActionTimeoutMs, 10);

    if (payload.ms !== undefined && payload.ms !== null) {
      await tab.page.waitForTimeout(Number(payload.ms));
      return;
    }

    if (payload.url) {
      await tab.page.waitForURL(String(payload.url), { timeout });
      return;
    }

    if (payload.urlContains) {
      const needle = String(payload.urlContains);
      await tab.page.waitForURL((url) => String(url).includes(needle), { timeout });
      return;
    }

    if (payload.networkIdle || String(payload.waitUntil || '').toLowerCase() === 'networkidle') {
      await tab.page.waitForLoadState('networkidle', { timeout });
      return;
    }

    if (payload.goneText) {
      const goneText = normalizeWhitespace(payload.goneText);
      const exactGone = parseBool(payload.exactGoneText, parseBool(payload.exact, false));
      const locator = exactGone
        ? tab.page.getByText(goneText, { exact: true }).first()
        : tab.page.getByText(goneText).first();
      await locator.waitFor({ timeout, state: 'hidden' });
      return;
    }

    if (payload.selector) {
      const state = normalizeWhitespace(payload.state) || 'visible';
      await tab.page.locator(String(payload.selector)).first().waitFor({ timeout, state });
      return;
    }

    if (payload.text) {
      const text = normalizeWhitespace(payload.text);
      const exact = parseBool(payload.exact, false);
      const locator = exact
        ? tab.page.getByText(text, { exact: true }).first()
        : tab.page.getByText(text).first();
      await locator.waitFor({ timeout, state: 'visible' });
      return;
    }

    await tab.page.waitForLoadState('domcontentloaded', { timeout });
  }

  decorateActionError(error, context = {}) {
    if (!error) return error;
    if (error.statusCode && error.code) return error;

    const message = String(error.message || error);
    const lower = message.toLowerCase();

    if (this.isPointerInterceptError(error)) {
      error.statusCode = 409;
      error.code = 'ELEMENT_INTERCEPTED';
      return error;
    }

    if (lower.includes('strict mode violation')) {
      error.statusCode = 409;
      error.code = 'AMBIGUOUS_TARGET';
      return error;
    }

    if (lower.includes('resolved to 0 elements') || lower.includes('no node found for selector')) {
      error.statusCode = 404;
      error.code = 'TARGET_NOT_FOUND';
      return error;
    }

    if (lower.includes('element is not visible') || lower.includes('not visible')) {
      error.statusCode = 409;
      error.code = 'NOT_VISIBLE';
      return error;
    }

    if (lower.includes('timeout')) {
      error.statusCode = 408;
      error.code = context.kind === 'wait' ? 'WAIT_TIMEOUT' : 'ACTION_TIMEOUT';
      return error;
    }

    if (!error.statusCode) {
      error.statusCode = 500;
    }
    if (!error.code) {
      error.code = 'ACTION_ERROR';
    }

    return error;
  }

  async resolveLocator(tab, payload) {
    if (payload.ref) {
      if (!tab.refs.size) {
        await this.refreshRefs(tab);
      }

      let info = tab.refs.get(String(payload.ref));
      if (!info) {
        await this.refreshRefs(tab);
        info = tab.refs.get(String(payload.ref));
      }

      if (!info) {
        const err = new Error(`Unknown ref: ${payload.ref}. Refresh snapshot and retry.`);
        err.statusCode = 409;
        err.code = 'STALE_REF';
        throw err;
      }

      const locator = await this.locatorFromRefInfo(tab, info);
      return {
        locator,
        target: {
          resolvedBy: 'ref',
          ref: String(payload.ref),
          handle: info.handle,
          strategy: info.strategy,
          role: info.role,
          name: info.name,
          nth: info.nth,
          selector: info.selector
        }
      };
    }

    if (payload.handle) {
      if (!tab.refs.size) {
        await this.refreshRefs(tab);
      }

      const handle = String(payload.handle);
      let info = [...tab.refs.values()].find((item) => item.handle === handle);
      if (!info) {
        await this.refreshRefs(tab);
        info = [...tab.refs.values()].find((item) => item.handle === handle);
      }

      if (info) {
        const locator = await this.locatorFromRefInfo(tab, info);
        return {
          locator,
          target: {
            resolvedBy: 'handle',
            handle,
            strategy: info.strategy,
            role: info.role,
            name: info.name,
            nth: info.nth,
            selector: info.selector
          }
        };
      }

      const hint = tab.handleHints?.get(handle);
      if (hint?.selector) {
        return {
          locator: tab.page.locator(hint.selector).first(),
          target: {
            resolvedBy: 'handle-hint',
            handle,
            strategy: 'selector',
            selector: hint.selector
          }
        };
      }

      if (hint?.role) {
        let locator = tab.page.getByRole(hint.role, hint.name ? { name: hint.name } : undefined);
        locator = locator.nth(hint.nth || 0);
        return {
          locator,
          target: {
            resolvedBy: 'handle-hint',
            handle,
            strategy: 'role',
            role: hint.role,
            name: hint.name,
            nth: hint.nth || 0
          }
        };
      }

      const err = new Error(`Unknown handle: ${handle}`);
      err.statusCode = 409;
      err.code = 'STALE_HANDLE';
      throw err;
    }

    if (payload.selector) {
      return {
        locator: tab.page.locator(payload.selector).first(),
        target: {
          resolvedBy: 'selector',
          selector: String(payload.selector)
        }
      };
    }

    if (payload.label) {
      const exact = parseBool(payload.exactLabel, parseBool(payload.exact, false));
      const nth = Math.max(0, Number.parseInt(payload.nth ?? '0', 10) || 0);
      const locator = exact
        ? tab.page.getByLabel(String(payload.label), { exact: true }).nth(nth)
        : tab.page.getByLabel(String(payload.label)).nth(nth);

      return {
        locator,
        target: {
          resolvedBy: 'label',
          label: normalizeWhitespace(payload.label),
          exact,
          nth
        }
      };
    }

    if (payload.role) {
      const role = String(payload.role);
      const exactName = parseBool(payload.exactName, parseBool(payload.exact, false));
      const name = payload.name ? String(payload.name) : undefined;
      const nth = Math.max(0, Number.parseInt(payload.nth ?? '0', 10) || 0);
      const locator = name
        ? tab.page.getByRole(role, exactName ? { name, exact: true } : { name }).nth(nth)
        : tab.page.getByRole(role).nth(nth);

      return {
        locator,
        target: {
          resolvedBy: 'role',
          role,
          name: name || null,
          exactName,
          nth
        }
      };
    }

    if (payload.text) {
      const text = String(payload.text);
      const exact = parseBool(payload.exact, true);
      const nth = Math.max(0, Number.parseInt(payload.nth ?? '0', 10) || 0);
      const locator = exact
        ? tab.page.getByText(text, { exact: true }).nth(nth)
        : tab.page.getByText(text).nth(nth);

      return {
        locator,
        target: {
          resolvedBy: 'text',
          text,
          exact,
          nth
        }
      };
    }

    const err = new Error('ref, handle, selector, label, role, or text is required');
    err.statusCode = 400;
    err.code = 'BAD_TARGET';
    throw err;
  }

  async locatorFromRefInfo(tab, info) {
    if (isValidRoleRef(info)) {
      let locator = tab.page.getByRole(info.role, info.name ? { name: info.name } : undefined);
      locator = locator.nth(info.nth || 0);
      return locator;
    }

    if (info.strategy === 'selector' && info.selector) {
      let locator = tab.page.locator(info.selector).first();
      const count = await locator.count().catch(() => 0);

      if (!count && info.name) {
        locator = tab.page.getByText(info.name, { exact: true }).first();
        const exactCount = await locator.count().catch(() => 0);
        if (!exactCount) {
          locator = tab.page.getByText(info.name).first();
        }
      }

      return locator;
    }

    const err = new Error(`Unsupported ref strategy`);
    err.statusCode = 400;
    err.code = 'UNSUPPORTED_TARGET';
    throw err;
  }

  attachTabObservers(tab) {
    const record = (event) => this.recordEvent(tab, event);

    tab.page.on('request', (request) => {
      const requestId = `r${tab.requestSeq++}`;
      tab.requestIds.set(request, requestId);

      record({
        kind: 'request',
        requestId,
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
        headers: request.headers(),
        postData: clipString(request.postData() || '', 4096)
      });
    });

    tab.page.on('response', async (response) => {
      const request = response.request();
      const requestId = tab.requestIds.get(request) || `r${tab.requestSeq++}`;

      const event = {
        kind: 'response',
        requestId,
        method: request.method(),
        url: response.url(),
        status: response.status(),
        statusText: response.statusText(),
        resourceType: request.resourceType(),
        headers: await response.allHeaders()
      };

      record(event);

      if (!this.config.captureResponseBodies) return;
      const contentType = event.headers['content-type'] || event.headers['Content-Type'] || '';
      if (!shouldCaptureBody(contentType)) return;

      try {
        const body = await response.body();
        const bodyDir = path.join(tab.artifactsDir, 'network-bodies');
        await fs.mkdir(bodyDir, { recursive: true });

        const max = this.config.maxCapturedBodyBytes;
        const clipped = body.length > max ? body.subarray(0, max) : body;
        const bodyPath = path.join(bodyDir, `${requestId}.bin`);
        await fs.writeFile(bodyPath, clipped);

        record({
          kind: 'response_body',
          requestId,
          url: response.url(),
          bytes: body.length,
          storedBytes: clipped.length,
          truncated: body.length > max,
          mimeType: parseMimeType(contentType),
          bodyPath
        });
      } catch (error) {
        record({
          kind: 'response_body_error',
          requestId,
          url: response.url(),
          error: String(error?.message || error)
        });
      }
    });

    tab.page.on('requestfailed', (request) => {
      const requestId = tab.requestIds.get(request) || `r${tab.requestSeq++}`;
      record({
        kind: 'request_failed',
        requestId,
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
        errorText: request.failure()?.errorText || 'unknown'
      });
    });

    tab.page.on('requestfinished', (request) => {
      const requestId = tab.requestIds.get(request) || `r${tab.requestSeq++}`;
      record({
        kind: 'request_finished',
        requestId,
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType()
      });
    });

    tab.page.on('console', (msg) => {
      record({
        kind: 'console',
        level: msg.type(),
        text: msg.text()
      });
    });

    tab.page.on('pageerror', (err) => {
      record({
        kind: 'page_error',
        error: String(err?.message || err)
      });
    });

    tab.page.on('download', async (download) => {
      const downloadId = `d${tab.downloadSeq++}`;
      const suggestedFilename = sanitizeFileName(download.suggestedFilename());
      const downloadDir = path.join(tab.artifactsDir, 'downloads');
      await fs.mkdir(downloadDir, { recursive: true });
      const savedPath = path.join(downloadDir, `${downloadId}-${suggestedFilename}`);

      const entry = {
        downloadId,
        suggestedFilename,
        startedAt: nowIso(),
        url: download.url(),
        status: 'started',
        savedPath: null,
        failure: null
      };
      tab.downloads.push(entry);

      record({
        kind: 'download_started',
        downloadId,
        url: entry.url,
        suggestedFilename
      });

      try {
        await download.saveAs(savedPath);
        const failure = await download.failure();
        if (failure) {
          entry.status = 'failed';
          entry.failure = failure;
        } else {
          entry.status = 'completed';
          entry.savedPath = savedPath;
        }
      } catch (error) {
        entry.status = 'failed';
        entry.failure = String(error?.message || error);
      }

      entry.completedAt = nowIso();

      record({
        kind: 'download_completed',
        downloadId,
        status: entry.status,
        savedPath: entry.savedPath,
        failure: entry.failure
      });
    });
  }

  recordEvent(tab, payload) {
    const event = {
      seq: this.eventSeq++,
      ts: nowIso(),
      tabId: tab.id,
      sessionId: tab.sessionId,
      ...payload
    };

    tab.events.push(event);
    if (tab.events.length > this.config.maxEventsPerTab) {
      tab.events.splice(0, tab.events.length - this.config.maxEventsPerTab);
    }

    const line = `${JSON.stringify(event)}\n`;
    fs.appendFile(tab.networkLogPath, line).catch(() => {});
  }

  async cleanupExpiredSessions() {
    const now = Date.now();
    const expired = [];

    for (const session of this.sessions.values()) {
      if (now - session.lastAccessAt > this.config.sessionTimeoutMs) {
        expired.push(session.id);
      }
    }

    for (const sessionId of expired) {
      await this.closeSession(sessionId).catch(() => {});
    }
  }
}
