import express from 'express';

import { loadConfig } from './config.js';
import { BrowserRuntime } from './runtime.js';

const config = loadConfig();
const runtime = new BrowserRuntime(config);
await runtime.init();

const app = express();
app.use(express.json({ limit: '4mb' }));

app.use((req, res, next) => {
  req.requestId = Math.random().toString(36).slice(2, 10);
  next();
});

app.get('/health', (req, res) => {
  res.json(runtime.health());
});

app.get('/capabilities', (req, res) => {
  res.json(runtime.capabilities());
});

// Sessions
app.get('/sessions', (req, res) => {
  res.json({ sessions: runtime.listSessions() });
});

app.post('/sessions', async (req, res, next) => {
  try {
    const session = await runtime.createSession(req.body || {});
    res.status(201).json(session);
  } catch (error) {
    next(error);
  }
});

app.get('/sessions/:sessionId', (req, res, next) => {
  try {
    const session = runtime.getSession(req.params.sessionId);
    res.json({
      id: session.id,
      persistent: session.persistent,
      authMode: session.authMode || (session.persistent ? 'shared' : 'ephemeral'),
      profileName: session.profileName,
      profileDir: session.profileDir,
      headless: session.headless,
      createdAt: session.createdAt,
      tabs: runtime.listTabs(session.id)
    });
  } catch (error) {
    next(error);
  }
});

app.delete('/sessions/:sessionId', async (req, res, next) => {
  try {
    const result = await runtime.closeSession(req.params.sessionId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/sessions/:sessionId/cookies', async (req, res, next) => {
  try {
    const result = await runtime.addCookies(req.params.sessionId, req.body?.cookies || []);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get('/sessions/:sessionId/cookies', async (req, res, next) => {
  try {
    const urls = req.query.url ? [String(req.query.url)] : [];
    const result = await runtime.getCookies(req.params.sessionId, urls);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Tabs
app.get('/sessions/:sessionId/tabs', (req, res, next) => {
  try {
    res.json({ tabs: runtime.listTabs(req.params.sessionId) });
  } catch (error) {
    next(error);
  }
});

app.post('/sessions/:sessionId/tabs', async (req, res, next) => {
  try {
    const tab = await runtime.createTab(req.params.sessionId, req.body || {});
    res.status(201).json(tab);
  } catch (error) {
    next(error);
  }
});

app.get('/tabs/:tabId', (req, res, next) => {
  try {
    const tab = runtime.getTabInfo(req.params.tabId);
    res.json(tab);
  } catch (error) {
    next(error);
  }
});

app.delete('/tabs/:tabId', async (req, res, next) => {
  try {
    const result = await runtime.closeTab(req.params.tabId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/tabs/:tabId/navigate', async (req, res, next) => {
  try {
    const url = req.body?.url;
    if (!url) {
      const error = new Error('url is required');
      error.statusCode = 400;
      error.code = 'BAD_NAVIGATE_REQUEST';
      throw error;
    }
    const result = await runtime.navigateTab(req.params.tabId, url);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/tabs/:tabId/inspect', async (req, res, next) => {
  try {
    const result = await runtime.inspectTab(req.params.tabId, req.body || {});
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/tabs/:tabId/query', async (req, res, next) => {
  try {
    const result = await runtime.queryTab(req.params.tabId, req.body || {});
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/tabs/:tabId/act', async (req, res, next) => {
  try {
    const result = await runtime.actTab(req.params.tabId, req.body || {});
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/tabs/:tabId/wait', async (req, res, next) => {
  try {
    const result = await runtime.waitTab(req.params.tabId, req.body || {});
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/tabs/:tabId/eval', async (req, res, next) => {
  try {
    const result = await runtime.evalTab(req.params.tabId, req.body || {});
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get('/tabs/:tabId/events', (req, res, next) => {
  try {
    const result = runtime.listEvents(req.params.tabId, req.query || {});
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Authenticated HTTP passthrough
app.post('/tabs/:tabId/fetch', async (req, res, next) => {
  try {
    const result = await runtime.tabFetch(req.params.tabId, req.body || {});
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Downloads
app.get('/tabs/:tabId/downloads', (req, res, next) => {
  try {
    const result = runtime.listDownloads(req.params.tabId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/tabs/:tabId/downloads/:downloadId/save', async (req, res, next) => {
  try {
    const outputPath = req.body?.path;
    if (!outputPath) {
      const error = new Error('path is required');
      error.statusCode = 400;
      error.code = 'BAD_DOWNLOAD_SAVE_REQUEST';
      throw error;
    }
    const result = await runtime.saveDownload(req.params.tabId, req.params.downloadId, outputPath);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  const status = error.statusCode || 500;
  const payload = {
    error: error.message || 'Internal Server Error',
    requestId: req.requestId
  };
  if (error.code) payload.code = error.code;
  if (error.actionTrace) payload.trace = error.actionTrace;
  if (config.nodeEnv !== 'production' && error.stack) payload.stack = error.stack;
  res.status(status).json(payload);
});

const server = app.listen(config.port, config.host, () => {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'info',
    msg: 'server_started',
    host: config.host,
    port: config.port,
    dataDir: config.dataDir,
    headless: config.headless
  }));
});

server.on('error', (error) => {
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'error',
    msg: 'server_error',
    error: error.message,
    code: error.code
  }));
  process.exit(1);
});

const shutdown = async (signal) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: 'shutdown', signal }));
  server.close(() => {});
  await runtime.close();
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
