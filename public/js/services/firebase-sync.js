// public/js/services/firebase-sync.js
// Optional cloud persistence. Active only when window.GROKBOT_ENV.firebase is configured.
// Anonymous auth; each night is stored under users/{uid}/runs/{runId} (see firestore.rules).

const SDK = 'https://www.gstatic.com/firebasejs/10.14.1';

export class FirebaseSync {
  constructor(env) {
    this.cfg = env?.firebase || null;
    this.ready = null;
  }

  get enabled() {
    return !!(this.cfg && this.cfg.apiKey && this.cfg.projectId);
  }

  async _init() {
    if (!this.enabled) throw new Error('Firebase is not configured');
    if (!this.ready) {
      this.ready = (async () => {
        const [{ initializeApp }, auth, fs] = await Promise.all([
          import(`${SDK}/firebase-app.js`),
          import(`${SDK}/firebase-auth.js`),
          import(`${SDK}/firebase-firestore.js`),
        ]);
        const app = initializeApp(this.cfg);
        const a = auth.getAuth(app);
        if (!a.currentUser) await auth.signInAnonymously(a);
        return { db: fs.getFirestore(app), uid: a.currentUser.uid, fs };
      })();
    }
    return this.ready;
  }

  async saveRun({ runId, config, recap, lines, usage }) {
    const { db, uid, fs } = await this._init();
    const ref = fs.doc(db, 'users', uid, 'runs', runId);
    await fs.setDoc(ref, {
      savedAt: fs.serverTimestamp(),
      config: JSON.stringify(config),
      recap: JSON.stringify(recap),
      usage: JSON.stringify(usage || {}),
      log: lines.slice(-1500).map((l) => `${l.clock} ${l.type} ${l.symbol} ${l.reason}`.slice(0, 300)),
    });
    return { uid, runId };
  }
}
