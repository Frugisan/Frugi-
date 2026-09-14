// ===== Frugi bundle : db.js + calc.js + app.js (script classique, sans modules) =====
(function(){
'use strict';

// ===== Frugi — couche de stockage local (IndexedDB) =====
// Tout reste sur l'appareil. Aucune donnée n'est jamais envoyée à un serveur.

const DB_NAME = 'frugi-db';
const DB_VERSION = 1;
const STORES = [
  'meta',              // clé/valeur : onboarding, foyer, réglages
  'profiles',          // profils du foyer (si plusieurs personnes)
  'revenus',
  'chargesFixes',
  'categoriesVariables',
  'depensesVariables',
  'enveloppes',        // prévoyance
  'mouvementsEnveloppe',
  'epargne',           // matelas / projets / investissement
  'mouvementsEpargne',
  'monthlyHistory'     // photo figée de chaque mois clos
];

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('INDEXEDDB_UNAVAILABLE'));
      return;
    }
    const timeout = setTimeout(() => reject(new Error('INDEXEDDB_TIMEOUT')), 4000);
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        STORES.forEach((name) => {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name, { keyPath: 'id' });
          }
        });
      };
      req.onsuccess = () => { clearTimeout(timeout); resolve(req.result); };
      req.onerror = () => { clearTimeout(timeout); reject(req.error || new Error('INDEXEDDB_ERROR')); };
      req.onblocked = () => { clearTimeout(timeout); reject(new Error('INDEXEDDB_BLOCKED')); };
    } catch (err) {
      clearTimeout(timeout);
      reject(err);
    }
  });
  return _dbPromise;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function tx(storeName, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    const result = fn(store);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
  });
}

const db = {
  uid,

  async getAll(storeName) {
    const database = await openDB();
    return new Promise((resolve, reject) => {
      const t = database.transaction(storeName, 'readonly');
      const req = t.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  async get(storeName, id) {
    const database = await openDB();
    return new Promise((resolve, reject) => {
      const req = database.transaction(storeName, 'readonly').objectStore(storeName).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  },

  async put(storeName, obj) {
    if (!obj.id) obj.id = uid();
    await tx(storeName, 'readwrite', (store) => store.put(obj));
    return obj;
  },

  async delete(storeName, id) {
    await tx(storeName, 'readwrite', (store) => store.delete(id));
  },

  async clear(storeName) {
    await tx(storeName, 'readwrite', (store) => store.clear());
  },

  // meta est un simple key/value (id = clé)
  async metaGet(key, fallback = null) {
    const row = await this.get('meta', key);
    return row ? row.value : fallback;
  },
  async metaSet(key, value) {
    return this.put('meta', { id: key, value });
  },

  async exportAll() {
    const dump = {};
    for (const s of STORES) dump[s] = await this.getAll(s);
    dump._exportedAt = new Date().toISOString();
    dump._app = 'frugi';
    return dump;
  },

  async importAll(dump) {
    for (const s of STORES) {
      if (!dump[s]) continue;
      await this.clear(s);
      for (const row of dump[s]) {
        await tx(s, 'readwrite', (store) => store.put(row));
      }
    }
  },

  async wipeAll() {
    for (const s of STORES) await this.clear(s);
  }
};


// ===== Frugi — logique de calcul =====

/** Unités de consommation du foyer (méthode standard INSEE simplifiée). */
function calcUC(foyer) {
  // foyer = { adultes, ados14plus, enfantsMoins14 }
  const adultes = Math.max(1, foyer.adultes || 1);
  const ados = foyer.ados14plus || 0;
  const enfants = foyer.enfantsMoins14 || 0;
  // 1er adulte = 1, chaque autre adulte OU ado 14+ = 0.5, chaque enfant -14 = 0.3
  const autresAdultes = adultes - 1;
  return 1 + (autresAdultes + ados) * 0.5 + enfants * 0.3;
}

/** Ramène un montant annuel lissé à un montant mensuel. */
function toMonthly(montant, recurrence) {
  return recurrence === 'annuel' ? montant / 12 : montant;
}

function sumRevenusMensuels(revenus) {
  return revenus.reduce((s, r) => s + toMonthly(r.montant, r.recurrence), 0);
}

function sumChargesFixesMensuelles(charges) {
  return charges.reduce((s, c) => {
    if (c.type === 'credit') return s + (c.mensualite || 0);
    return s + toMonthly(c.montant, c.recurrence);
  }, 0);
}

/** Dépenses réelles du mois pour les charges variables. */
function sumDepensesVariablesDuMois(depenses, mois) {
  return depenses.filter((d) => d.date.slice(0, 7) === mois).reduce((s, d) => s + d.montant, 0);
}

/** Provision mensuelle d'une enveloppe = montant cible / durée (en mois). */
function provisionMensuelle(enveloppe) {
  if (!enveloppe.dureeMois || enveloppe.dureeMois <= 0) return 0;
  return enveloppe.montantCible / enveloppe.dureeMois;
}

function sumProvisionsEnveloppes(enveloppes) {
  return enveloppes.reduce((s, e) => s + provisionMensuelle(e), 0);
}

/**
 * Reste à vivre du mois.
 * revenus - (charges fixes + dépenses variables réelles + provisions prévoyance + épargne allouée)
 */
function calcResteAVivre({ revenus, chargesFixes, depensesVariablesMois, provisionsEnveloppes, epargneAllouee }) {
  const total = sumRevenusMensuels(revenus);
  const sortiesFixes = sumChargesFixesMensuelles(chargesFixes);
  return total - sortiesFixes - depensesVariablesMois - provisionsEnveloppes - epargneAllouee;
}

function seuilAlerte(resteParUC, seuils = { orange: 800, rouge: 600 }) {
  if (resteParUC < seuils.rouge) return 'rouge';
  if (resteParUC < seuils.orange) return 'orange';
  return 'ok';
}

/**
 * Répartition intérêts/capital d'une mensualité de crédit.
 * Si taux fourni : méthode d'amortissement classique.
 * Sinon : diminution linéaire simplifiée (approximation signalée à l'utilisateur).
 */
function decompositionMensualite(credit) {
  const { capitalRestant, mensualite, tauxAnnuel } = credit;
  if (tauxAnnuel && tauxAnnuel > 0) {
    const tauxMensuel = tauxAnnuel / 100 / 12;
    const interets = capitalRestant * tauxMensuel;
    const capitalRembourse = Math.max(0, mensualite - interets);
    return { interets, capitalRembourse, estimation: false };
  }
  // Estimation linéaire simplifiée : on suppose que toute la mensualité rembourse du capital
  // à un rythme constant (pas de calcul d'intérêts réel).
  return { interets: 0, capitalRembourse: mensualite, estimation: true };
}

function formatEUR(montant) {
  const n = Number(montant) || 0;
  return n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
}

function formatEURPrecise(montant) {
  const n = Number(montant) || 0;
  return n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 });
}

function currentMonthKey(date = new Date()) {
  return date.toISOString().slice(0, 7); // YYYY-MM
}

function moisLisible(mois) {
  const [y, m] = mois.split('-').map(Number);
  const d = new Date(y, m - 1, 1);
  return d.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
}

const C = { calcUC, toMonthly, sumRevenusMensuels, sumChargesFixesMensuelles, sumDepensesVariablesDuMois, provisionMensuelle, sumProvisionsEnveloppes, calcResteAVivre, seuilAlerte, decompositionMensualite, formatEUR, formatEURPrecise, currentMonthKey, moisLisible };



const app = document.getElementById('app');

let state = {
  route: 'loading',
  ob: { step: 0, adultes: 1, ados: 0, enfants: 0, typeRevenus: 'stable', nbProfilsChoice: 'seul', profils: [] },
  chargesTab: 'fixes',
  sheet: null, // { html, onMount }
  viewMode: 'foyer', // 'foyer' | 'individuel'
  historiqueAnnee: new Date().getFullYear(),
  historiqueMetriques: { resteAVivre: true, revenus: false, chargesFixes: false, depensesVar: false, provisions: false },
  simulation: null,
};

let cache = { foyer: null, revenus: [], chargesFixes: [], categoriesVariables: [], depensesVariables: [], epargne: [], mouvementsEpargne: [], enveloppes: [], mouvementsEnveloppe: [], profiles: [], monthlyHistory: [], repartitionMode: 'egales' };
let printMonth = null;

function render() {
  closeKeyboardSafe();
  let html = '';
  if (state.route === 'onboarding') html = renderOnboarding();
  else if (state.route === 'home') html = renderHome();
  else if (state.route === 'revenus') html = renderRevenus();
  else if (state.route === 'charges') html = renderCharges();
  else if (state.route === 'prevoyance') html = renderPrevoyance();
  else if (state.route === 'epargne') html = renderEpargne();
  else if (state.route === 'historique') html = renderHistorique();
  else if (state.route === 'pedagogie') html = renderPedagogie();
  else if (state.route === 'settings') html = renderSettings();
  else if (state.route === 'simulation') html = renderSimulation();
  else if (state.route === 'print-bilan') { html = renderPrintBilan(printMonth); app.innerHTML = html; setTimeout(() => window.print(), 250); return; }
  else html = '<div class="screen"></div>';

  app.innerHTML = html + (state.route !== 'onboarding' ? renderBottomNav() : '') + renderSheet();
}

function closeKeyboardSafe() { if (document.activeElement) document.activeElement.blur(); }

function go(route) { state.route = route; render(); window.scrollTo(0, 0); }
function openSheet(html) { state.sheet = html; render(); }
function closeSheet() { state.sheet = null; render(); }

// ===================== BOOT =====================
async function boot() {
  try {
    const dark = await db.metaGet('darkMode', false);
    if (dark) document.body.classList.add('dark');
    const onboardingComplete = await db.metaGet('onboardingComplete', false);
    await reloadCache();
    state.route = onboardingComplete ? 'home' : 'onboarding';
    render();
  } catch (err) {
    renderStorageError(err);
  }
}

function renderStorageError(err) {
  const isFileProtocol = location.protocol === 'file:';
  app.innerHTML = `
    <div class="screen" style="padding-top:60px; text-align:center;">
      ${logoSVG(64)}
      <h1 style="font-size:20px; margin-top:16px;">Frugi ne peut pas démarrer ici</h1>
      <div class="card" style="text-align:left; margin-top:20px;">
        ${isFileProtocol ? `
          <p style="font-size:14px; line-height:1.6;">
            Ton navigateur bloque le stockage local quand la page est ouverte directement depuis un fichier
            (c'est une protection de vie privée, fréquente sur iPhone/Safari).
          </p>
          <p style="font-size:14px; line-height:1.6; margin-top:12px;">
            Pour que Frugi fonctionne et sauvegarde tes données, il faut l'ouvrir via une vraie adresse web
            (<b>http://</b> ou <b>https://</b>) plutôt qu'en double-cliquant sur le fichier. La solution la plus simple :
            héberger le dossier Frugi gratuitement (Netlify, GitHub Pages...).
          </p>
        ` : `
          <p style="font-size:14px; line-height:1.6;">
            Le stockage local de ton navigateur semble indisponible ou désactivé
            (mode navigation privée stricte, réglages de confidentialité...).
          </p>
          <p style="font-size:14px; line-height:1.6; margin-top:12px;">Essaie de désactiver la navigation privée, ou un autre navigateur.</p>
        `}
      </div>
      <button class="btn btn-secondary btn-block" style="margin-top:16px;" onclick="location.reload()">Réessayer</button>
    </div>`;
}

async function reloadCache() {
  cache.foyer = await db.metaGet('foyer', null);
  cache.revenus = await db.getAll('revenus');
  cache.chargesFixes = await db.getAll('chargesFixes');
  cache.categoriesVariables = await db.getAll('categoriesVariables');
  cache.depensesVariables = await db.getAll('depensesVariables');
  cache.epargne = await db.getAll('epargne');
  cache.mouvementsEpargne = await db.getAll('mouvementsEpargne');
  cache.enveloppes = await db.getAll('enveloppes');
  cache.mouvementsEnveloppe = await db.getAll('mouvementsEnveloppe');
  cache.profiles = await db.getAll('profiles');
  cache.repartitionMode = await db.metaGet('repartitionMode', 'egales');
  cache.lastExportDate = await db.metaGet('lastExportDate', null);
  cache.exportReminderDismissedAt = await db.metaGet('exportReminderDismissedAt', null);
  cache.firstUseDate = await db.metaGet('firstUseDate', null);
  await snapshotCurrentMonth();
  cache.monthlyHistory = await db.getAll('monthlyHistory');
}

/** Fige une photo du mois en cours dans l'historique (mise à jour à chaque session). */
async function snapshotCurrentMonth() {
  const mois = C.currentMonthKey();
  const foyer = cache.foyer || { adultes: 1, ados14plus: 0, enfantsMoins14: 0 };
  const uc = C.calcUC(foyer);
  const revenusMensuel = C.sumRevenusMensuels(cache.revenus);
  const chargesFixesMensuel = C.sumChargesFixesMensuelles(cache.chargesFixes);
  const depensesVarMois = C.sumDepensesVariablesDuMois(cache.depensesVariables, mois);
  const provisionsMois = C.sumProvisionsEnveloppes(cache.enveloppes);
  const resteAVivre = revenusMensuel - chargesFixesMensuel - depensesVarMois - provisionsMois;
  const repartitionMode = await db.metaGet('repartitionMode', 'egales');
  await db.put('monthlyHistory', {
    id: mois, mois, revenusMensuel, chargesFixesMensuel, depensesVarMois, provisionsMois,
    resteAVivre, uc, repartitionMode, nbProfils: (cache.profiles || []).length || 1,
  });
}

/** Calcule le reste à vivre par profil selon le mode de répartition choisi. */
function calcRepartitionParProfil(mode, profiles, revenus, chargesFixes, autresChargesCommunes) {
  const n = profiles.length || 1;
  const revenuDe = (id) => C.sumRevenusMensuels(revenus.filter((r) => r.profileId === id));
  const totalRevenu = profiles.reduce((s, p) => s + revenuDe(p.id), 0);
  const totalChargesFixes = C.sumChargesFixesMensuelles(chargesFixes);
  const totalCharges = totalChargesFixes + autresChargesCommunes;

  if (mode === 'libre') {
    const part = {};
    profiles.forEach((p) => { part[p.id] = autresChargesCommunes / n; });
    chargesFixes.forEach((c) => {
      const montantLigne = c.type === 'credit' ? (c.mensualite || 0) : C.toMonthly(c.montant, c.recurrence);
      const rep = c.repartitionLibre;
      profiles.forEach((p) => {
        const pct = rep && rep[p.id] != null ? rep[p.id] : 100 / n;
        part[p.id] += montantLigne * (pct / 100);
      });
    });
    return profiles.map((p) => ({ ...p, revenu: revenuDe(p.id), resteAVivre: revenuDe(p.id) - part[p.id] }));
  }
  if (mode === 'equitable') {
    const communResteTotal = totalRevenu - totalCharges;
    const each = communResteTotal / n;
    return profiles.map((p) => ({ ...p, revenu: revenuDe(p.id), resteAVivre: each }));
  }
  if (mode === 'prorata' && totalRevenu > 0) {
    return profiles.map((p) => {
      const revenu = revenuDe(p.id);
      const part = revenu / totalRevenu;
      return { ...p, revenu, resteAVivre: revenu - totalCharges * part };
    });
  }
  // parts égales (par défaut)
  return profiles.map((p) => {
    const revenu = revenuDe(p.id);
    return { ...p, revenu, resteAVivre: revenu - totalCharges / n };
  });
}

// ===================== LOGO =====================
function logoSVG(size = 28) {
  return `<img class="logo" src="./icons/icon-192.png" width="${size}" height="${size}" alt="Frugi" style="border-radius:${Math.round(size * 0.24)}px; display:block;" />`;
}

// ===================== ONBOARDING =====================
function renderOnboarding() {
  const { step } = state.ob;
  const total = 4;
  const dots = Array.from({ length: total }).map((_, i) =>
    `<div class="dot ${i < step ? 'done' : ''}"></div>`).join('');

  let body = '';
  if (step === 0) {
    body = `
      <div class="screen" style="padding-top:40px; text-align:center;">
        ${logoSVG(72)}
        <h1 style="font-size:26px; margin-top:16px;">Bienvenue sur Frugi</h1>
        <p style="color:var(--text-soft); margin-top:8px; line-height:1.5;">
          Ton budget, chez toi, pour toi. Gratuit, privé, sans compte.<br>Tout reste sur cet appareil.
        </p>
        <div style="margin-top:32px;">
          <button class="btn btn-primary btn-block" data-action="ob-next">Commencer</button>
        </div>
      </div>`;
  } else if (step === 1) {
    body = `
      <div class="screen">
        <h2>Qui partage ce budget ?</h2>
        <p style="color:var(--text-soft); font-size:13px; margin-bottom:20px;">Ça permet de calculer ton reste à vivre par personne, de façon plus juste.</p>
        <div class="card">
          <div class="field">
            <label>Adultes dans le foyer</label>
            <div class="stepper">
              <button data-action="ob-dec" data-field="adultes">−</button>
              <span class="val">${state.ob.adultes}</span>
              <button data-action="ob-inc" data-field="adultes">+</button>
            </div>
          </div>
          <div class="field">
            <label>Enfants / ados de 14 ans et plus</label>
            <div class="stepper">
              <button data-action="ob-dec" data-field="ados">−</button>
              <span class="val">${state.ob.ados}</span>
              <button data-action="ob-inc" data-field="ados">+</button>
            </div>
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Enfants de moins de 14 ans</label>
            <div class="stepper">
              <button data-action="ob-dec" data-field="enfants">−</button>
              <span class="val">${state.ob.enfants}</span>
              <button data-action="ob-inc" data-field="enfants">+</button>
            </div>
          </div>
        </div>
        <button class="btn btn-primary btn-block" data-action="ob-next">Continuer</button>
      </div>`;
  } else if (step === 2) {
    body = `
      <div class="screen">
        <h2>Tes revenus sont-ils réguliers ?</h2>
        <p style="color:var(--text-soft); font-size:13px; margin-bottom:20px;">Ça nous aide à te conseiller une durée de matelas de sécurité adaptée.</p>
        <div class="choice-list">
          <button class="choice-card ${state.ob.typeRevenus === 'stable' ? 'selected' : ''}" data-action="ob-set" data-field="typeRevenus" data-value="stable">
            <div class="choice-title">Stables</div>
            <div class="choice-desc">Salarié·e, retraité·e, pension régulière. On te conseillera un matelas de 3 mois.</div>
          </button>
          <button class="choice-card ${state.ob.typeRevenus === 'irregulier' ? 'selected' : ''}" data-action="ob-set" data-field="typeRevenus" data-value="irregulier">
            <div class="choice-title">Irréguliers</div>
            <div class="choice-desc">Indépendant·e, freelance, revenus variables. On te conseillera un matelas de 6 mois.</div>
          </button>
        </div>
        <button class="btn btn-primary btn-block" style="margin-top:16px;" data-action="ob-next">Continuer</button>
      </div>`;
  } else if (step === 3) {
    const opts = [
      ['seul', 'Seul·e', "Tu gères ton budget seul·e."],
      ['deux', 'À deux', "En couple ou à deux, budget partagé."],
      ['plusieurs', 'À plusieurs', "Colocation, famille recomposée, aidant·e..."],
      ['plus_tard', 'Je déciderai plus tard', "Tu pourras changer ça à tout moment dans les réglages."],
    ];
    const besoinNoms = state.ob.nbProfilsChoice === 'deux' || state.ob.nbProfilsChoice === 'plusieurs';
    body = `
      <div class="screen">
        <h2>Combien de personnes partagent ce budget ?</h2>
        <div class="choice-list" style="margin-top:16px;">
          ${opts.map(([v, t, d]) => `
            <button class="choice-card ${state.ob.nbProfilsChoice === v ? 'selected' : ''}" data-action="ob-set" data-field="nbProfilsChoice" data-value="${v}">
              <div class="choice-title">${t}</div>
              <div class="choice-desc">${d}</div>
            </button>`).join('')}
        </div>
        <button class="btn btn-primary btn-block" style="margin-top:16px;" data-action="${besoinNoms ? 'ob-next-noms' : 'ob-finish'}">${besoinNoms ? 'Continuer' : 'Terminer et découvrir Frugi'}</button>
      </div>`;
  } else if (step === 4) {
    if (state.ob.profils.length === 0) state.ob.profils = ['', ''];
    body = `
      <div class="screen">
        <h2>Comment tu t'appelles ?</h2>
        <p style="color:var(--text-soft); font-size:13px; margin-bottom:16px;">Ça nous permet d'afficher le reste à vivre de chacun·e.</p>
        <div class="card">
          ${state.ob.profils.map((nom, i) => `
            <div class="field" style="margin-bottom:${i === state.ob.profils.length - 1 ? '0' : '14px'};">
              <label>Personne ${i + 1}</label>
              <input data-ob-nom-index="${i}" value="${escapeHTML(nom)}" placeholder="Prénom" />
            </div>`).join('')}
        </div>
        ${state.ob.nbProfilsChoice === 'plusieurs' ? `<button class="btn btn-ghost" data-action="ob-add-nom">+ Ajouter une personne</button>` : ''}
        <button class="btn btn-primary btn-block" style="margin-top:16px;" data-action="ob-finish">Terminer et découvrir Frugi</button>
      </div>`;
  }

  return `<div class="onboard-progress">${dots}</div>${body}`;
}

async function finishOnboarding() {
  const nbMap = { seul: 1, deux: 2, plusieurs: 3, plus_tard: 1 };
  const foyer = {
    adultes: state.ob.adultes,
    ados14plus: state.ob.ados,
    enfantsMoins14: state.ob.enfants,
    typeRevenus: state.ob.typeRevenus,
    nbProfilsChoice: state.ob.nbProfilsChoice,
    nbProfils: nbMap[state.ob.nbProfilsChoice] || 1,
  };
  await db.metaSet('foyer', foyer);
  await db.metaSet('onboardingComplete', true);
  await db.metaSet('seuils', { orange: 800, rouge: 600 });
  await db.metaSet('firstUseDate', new Date().toISOString());
  const noms = (state.ob.profils || []).map((n) => n.trim()).filter(Boolean);
  for (const nom of noms) {
    await db.put('profiles', { nom });
  }
  await reloadCache();
  go('home');
}

// ===================== BOTTOM NAV =====================
function renderBottomNav() {
  const items = [
    ['home', '🏠', 'Accueil'],
    ['charges', '🧾', 'Charges'],
    ['prevoyance', '🧺', 'Prévoyance'],
    ['epargne', '🌱', 'Épargne'],
    ['historique', '📊', 'Historique'],
  ];
  return `<nav class="bottom-nav">
    ${items.map(([r, icon, label]) => `
      <button class="nav-item ${state.route === r ? 'active' : ''}" data-action="go" data-route="${r}">
        <span class="nav-icon">${icon}</span>
        <span>${label}</span>
      </button>`).join('')}
  </nav>`;
}

function topbar(title, subtitle, opts = {}) {
  return `<div class="topbar">
    ${logoSVG(30)}
    <div>
      <h1>${title}</h1>
      ${subtitle ? `<div class="subtitle">${subtitle}</div>` : ''}
    </div>
    <div class="topbar-spacer"></div>
    ${opts.hideSettings ? '' : `<button class="icon-btn" data-action="go" data-route="settings" aria-label="Réglages">⚙️</button>`}
  </div>`;
}

function shouldRemindExport() {
  const hasData = cache.revenus.length > 0 || cache.chargesFixes.length > 0;
  if (!hasData) return false;
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.now();
  if (cache.exportReminderDismissedAt && now - new Date(cache.exportReminderDismissedAt).getTime() < 14 * DAY) return false;
  if (cache.lastExportDate) return now - new Date(cache.lastExportDate).getTime() > 30 * DAY;
  const depuis = cache.firstUseDate ? now - new Date(cache.firstUseDate).getTime() : 0;
  return depuis > 14 * DAY;
}

// ===================== HOME =====================
function renderHome() {
  const foyer = cache.foyer || { adultes: 1, ados14plus: 0, enfantsMoins14: 0 };
  const uc = C.calcUC(foyer);
  const mois = C.currentMonthKey();
  const revenusMensuel = C.sumRevenusMensuels(cache.revenus);
  const chargesFixesMensuel = C.sumChargesFixesMensuelles(cache.chargesFixes);
  const depensesVarMois = C.sumDepensesVariablesDuMois(cache.depensesVariables, mois);
  const budgetVarTotal = cache.categoriesVariables.reduce((s, c) => s + (c.budgetPrevisionnel || 0), 0);
  const provisionsMois = C.sumProvisionsEnveloppes(cache.enveloppes);

  const resteAVivre = revenusMensuel - chargesFixesMensuel - depensesVarMois - provisionsMois;
  const resteParUC = resteAVivre / uc;
  const seuils = { orange: 800, rouge: 600 };
  const niveau = C.seuilAlerte(resteParUC, seuils);
  const niveauColor = niveau === 'rouge' ? 'var(--alerte-dark)' : niveau === 'orange' ? 'var(--prevoyance-dark)' : 'var(--revenus-dark)';

  const pctUtilise = revenusMensuel > 0 ? Math.max(0, Math.min(100, ((chargesFixesMensuel + depensesVarMois + provisionsMois) / revenusMensuel) * 100)) : 0;
  const gauge = arcGauge(pctUtilise, niveauColor);
  const rappelExport = shouldRemindExport();

  const matelas = cache.epargne.find((e) => e.type === 'matelas');
  const matelasMontant = matelas ? matelas.montantAccumule : 0;
  const matelasObjectif = matelas ? matelas.objectif : 0;

  return `
    ${topbar('Frugi', C.moisLisible(mois))}
    <div class="screen" style="padding-top:6px;">
      ${rappelExport ? `
      <div class="card-sm" style="display:flex; align-items:center; gap:10px; margin-bottom:14px; background:var(--prevoyance); border-radius:var(--radius-md);">
        <span style="font-size:20px;">💾</span>
        <div style="flex:1; font-size:12.5px; color:#5A4B1F;">Pense à exporter une sauvegarde de tes données.</div>
        <button class="btn btn-secondary" style="padding:6px 10px; font-size:12px;" data-action="export-json">Exporter</button>
        <button class="icon-btn" style="width:28px; height:28px;" data-action="dismiss-export-reminder">✕</button>
      </div>` : ''}
      <div class="card" style="text-align:center;">
        <div class="gauge-wrap">
          ${gauge}
          <div class="gauge-value">${C.formatEUR(resteAVivre)}</div>
          <div class="gauge-label">reste à vivre ce mois-ci</div>
          <div class="gauge-sub">soit ${C.formatEUR(resteParUC)} / unité de consommation</div>
          ${niveau !== 'ok' ? `<div style="margin-top:10px;"><span class="badge-alert">${niveau === 'rouge' ? 'Vigilance renforcée' : 'À surveiller'}</span></div>` : ''}
        </div>
      </div>

      ${cache.profiles.length > 1 ? renderRepartitionHome(revenusMensuel, provisionsMois + depensesVarMois) : ''}

      <div class="card-sm" style="display:flex; gap:10px; margin-bottom:14px;">
        <button class="btn btn-secondary" style="flex:1; font-size:13px;" data-action="go" data-route="revenus">💶 Revenus<br><b>${C.formatEUR(revenusMensuel)}</b></button>
        <button class="btn btn-secondary" style="flex:1; font-size:13px;" data-action="go" data-route="charges">🧾 Charges fixes<br><b>${C.formatEUR(chargesFixesMensuel)}</b></button>
      </div>

      <div class="card">
        <h2 style="font-size:15px;">Dépenses courantes du mois</h2>
        <p style="font-size:12.5px; color:var(--text-soft); margin-top:2px;">
          ${C.formatEUR(depensesVarMois)} dépensés sur ${C.formatEUR(budgetVarTotal)} prévus
        </p>
        <div class="progress-track" style="margin-top:10px;">
          <div class="progress-fill" style="width:${budgetVarTotal > 0 ? Math.min(100, (depensesVarMois / budgetVarTotal) * 100) : 0}%; background:var(--charges-var-dark);"></div>
        </div>
        <button class="btn btn-ghost" style="margin-top:10px; padding-left:0;" data-action="go" data-route="charges" data-tab="variables">Voir le détail →</button>
      </div>

      ${cache.enveloppes.length > 0 ? `
      <div class="card">
        <h2 style="font-size:15px;">🧺 Prévoyance</h2>
        <p style="font-size:12.5px; color:var(--text-soft); margin-top:2px;">
          ${C.formatEUR(provisionsMois)} à provisionner ce mois sur ${cache.enveloppes.length} enveloppe${cache.enveloppes.length > 1 ? 's' : ''}
        </p>
        <button class="btn btn-ghost" style="margin-top:8px; padding-left:0;" data-action="go" data-route="prevoyance">Voir les enveloppes →</button>
      </div>` : ''}

      <div class="card">
        <h2 style="font-size:15px;">🌱 Matelas de sécurité</h2>
        <p style="font-size:12.5px; color:var(--text-soft); margin-top:2px;">
          ${C.formatEUR(matelasMontant)} / ${C.formatEUR(matelasObjectif)}
        </p>
        <div class="progress-track" style="margin-top:10px;">
          <div class="progress-fill" style="width:${matelasObjectif > 0 ? Math.min(100, (matelasMontant / matelasObjectif) * 100) : 0}%; background:var(--epargne-dark);"></div>
        </div>
        <button class="btn btn-ghost" style="margin-top:10px; padding-left:0;" data-action="go" data-route="epargne">Voir l'épargne →</button>
      </div>
    </div>`;
}

function renderRepartitionHome(revenusMensuel, autresChargesCommunes) {
  const modeLabels = { egales: 'Parts égales', prorata: 'Prorata des revenus', equitable: 'Équitable (pot commun)', libre: 'Libre' };
  const repartition = calcRepartitionParProfil(cache.repartitionMode, cache.profiles, cache.revenus, cache.chargesFixes, autresChargesCommunes);
  return `
      <div class="card">
        <div style="display:flex; align-items:center; margin-bottom:10px;">
          <h2 style="font-size:15px; flex:1;">👥 Répartition du foyer</h2>
          <span class="tag" style="background:var(--charges-fixes); color:#2E4A6B;">${modeLabels[cache.repartitionMode] || 'Parts égales'}</span>
        </div>
        <div style="display:flex; gap:8px; margin-bottom:${state.viewMode === 'individuel' ? '12px' : '0'};">
          <button class="btn ${state.viewMode === 'foyer' ? 'btn-primary' : 'btn-secondary'}" style="flex:1; font-size:12.5px; padding:8px;" data-action="set-view-mode" data-mode="foyer">Vue foyer</button>
          <button class="btn ${state.viewMode === 'individuel' ? 'btn-primary' : 'btn-secondary'}" style="flex:1; font-size:12.5px; padding:8px;" data-action="set-view-mode" data-mode="individuel">Par personne</button>
        </div>
        ${state.viewMode === 'individuel' ? repartition.map((p) => `
          <div class="line-item">
            <div class="line-head">
              <span class="line-name">${escapeHTML(p.nom)}</span>
              <span style="font-weight:700; color:${p.resteAVivre < 0 ? 'var(--alerte-dark)' : 'inherit'};">${C.formatEUR(p.resteAVivre)}</span>
            </div>
            <div class="line-amounts">revenu : ${C.formatEUR(p.revenu)}</div>
          </div>`).join('') : ''}
        ${cache.repartitionMode === 'libre' ? `<button class="btn btn-ghost" style="margin-top:8px; padding-left:0;" data-action="go" data-route="charges">Régler la répartition ligne par ligne →</button>` : ''}
      </div>`;
}

function arcGauge(pctUsed, color) {
  // Jauge en arc : 0% utilisé = plein, 100% utilisé = vide (vision "reste à vivre")
  const remaining = 100 - pctUsed;
  const r = 70, cx = 90, cy = 90;
  const circumference = Math.PI * r; // demi-cercle
  const offset = circumference * (1 - remaining / 100);
  return `
    <svg width="180" height="100" viewBox="0 0 180 100">
      <path d="M 20 90 A 70 70 0 0 1 160 90" fill="none" stroke="#EFEAE0" stroke-width="14" stroke-linecap="round"/>
      <path d="M 20 90 A 70 70 0 0 1 160 90" fill="none" stroke="${color}" stroke-width="14" stroke-linecap="round"
        stroke-dasharray="${circumference}" stroke-dashoffset="${offset}" style="transition: stroke-dashoffset 0.5s ease;"/>
    </svg>`;
}

// ===================== SHEET WRAPPER =====================
function renderSheet() {
  if (!state.sheet) return '';
  return `<div class="sheet-backdrop" data-action="close-sheet">
    <div class="sheet" data-stop>${state.sheet}</div>
  </div>`;
}

function sheetHeader(title) {
  return `<div class="sheet-head"><h2>${title}</h2>
    <button class="icon-btn" data-action="close-sheet">✕</button></div>`;
}

// ===================== REVENUS =====================
const ICONES_REVENU = { salaire: '💼', allocation: '🏛️', pension: '🧓', autre: '➕' };

function renderRevenus() {
  const total = C.sumRevenusMensuels(cache.revenus);
  return `
    ${topbar('Revenus', `${C.formatEUR(total)} / mois`)}
    <div class="screen" style="padding-top:6px;">
      <div class="card">
        ${cache.revenus.length === 0 ? emptyState('💶', "Ajoute ton premier revenu : salaire, allocation, pension...") :
          cache.revenus.map((r) => `
            <div class="line-item">
              <div class="line-head">
                <span class="line-icon">${ICONES_REVENU[r.categorie] || '💶'}</span>
                <span class="line-name">${escapeHTML(r.nom)}</span>
                <span style="font-weight:700;">${C.formatEUR(r.montant)}</span>
                <button class="icon-btn" data-action="del-revenu" data-id="${r.id}">🗑️</button>
              </div>
              <div class="line-amounts">
                ${r.recurrence === 'annuel' ? 'Annuel, lissé : ' + C.formatEUR(r.montant / 12) + ' / mois' : 'Mensuel'}
                ${cache.profiles.length > 1 && r.profileId ? ' · ' + escapeHTML((cache.profiles.find((p) => p.id === r.profileId) || {}).nom || '') : ''}
              </div>
            </div>`).join('')}
      </div>
      <button class="btn btn-primary btn-block" data-action="open-add-revenu">+ Ajouter un revenu</button>
    </div>`;
}

function sheetAddRevenu() {
  return `${sheetHeader('Ajouter un revenu')}
    <form data-action="submit-revenu">
      <div class="field">
        <label>Nom</label>
        <input name="nom" placeholder="Ex : Salaire, CAF, Pension..." required />
      </div>
      ${cache.profiles.length > 1 ? `
      <div class="field">
        <label>Rattaché à</label>
        <select name="profileId">
          ${cache.profiles.map((p) => `<option value="${p.id}">${escapeHTML(p.nom)}</option>`).join('')}
        </select>
      </div>` : ''}
      <div class="field">
        <label>Catégorie</label>
        <select name="categorie">
          <option value="salaire">💼 Salaire</option>
          <option value="allocation">🏛️ Allocation</option>
          <option value="pension">🧓 Pension</option>
          <option value="autre">➕ Autre</option>
        </select>
      </div>
      <div class="field-row">
        <div class="field">
          <label>Montant</label>
          <input name="montant" type="number" step="0.01" min="0" placeholder="0" required inputmode="decimal" />
        </div>
        <div class="field">
          <label>Récurrence</label>
          <select name="recurrence">
            <option value="mensuel">Mensuel</option>
            <option value="annuel">Annuel (lissé)</option>
          </select>
        </div>
      </div>
      <button class="btn btn-primary btn-block" type="submit">Enregistrer</button>
    </form>`;
}

// ===================== CHARGES =====================
const ICONES_CHARGE = { loyer: '🏠', credit: '🏦', assurance: '🛡️', abonnement: '📺', energie: '⚡', autre: '➕' };

function renderCharges() {
  const totalFixes = C.sumChargesFixesMensuelles(cache.chargesFixes);
  return `
    ${topbar('Charges', state.chargesTab === 'fixes' ? `${C.formatEUR(totalFixes)} / mois` : '')}
    <div class="screen" style="padding-top:6px;">
      <div style="display:flex; gap:8px; margin-bottom:14px;">
        <button class="btn ${state.chargesTab === 'fixes' ? 'btn-primary' : 'btn-secondary'}" style="flex:1;" data-action="charges-tab" data-tab="fixes">Fixes</button>
        <button class="btn ${state.chargesTab === 'variables' ? 'btn-primary' : 'btn-secondary'}" style="flex:1;" data-action="charges-tab" data-tab="variables">Courantes</button>
      </div>
      ${state.chargesTab === 'fixes' ? renderChargesFixes() : renderChargesVariables()}
    </div>`;
}

function renderChargesFixes() {
  const libreActif = cache.repartitionMode === 'libre' && cache.profiles.length > 1;
  return `
    <div class="card">
      ${cache.chargesFixes.length === 0 ? emptyState('🧾', "Ajoute tes charges fixes : loyer, assurances, abonnements...") :
        cache.chargesFixes.map((c) => {
          const montantAffiche = c.type === 'credit' ? c.mensualite : toM(c);
          const jaugeCredit = c.type === 'credit' && c.capitalInitial
            ? Math.max(0, Math.min(100, 100 - (c.capitalRestant / c.capitalInitial) * 100)) : null;
          const n = cache.profiles.length || 1;
          const repartitionTexte = libreActif ? cache.profiles.map((p) => {
            const pct = c.repartitionLibre && c.repartitionLibre[p.id] != null ? c.repartitionLibre[p.id] : 100 / n;
            return `${escapeHTML(p.nom)} ${Math.round(pct)}%`;
          }).join(' · ') : '';
          return `
            <div class="line-item">
              <div class="line-head">
                <span class="line-icon">${ICONES_CHARGE[c.type === 'credit' ? 'credit' : c.categorie] || '🧾'}</span>
                <span class="line-name">${escapeHTML(c.nom)}</span>
                <span style="font-weight:700;">${C.formatEUR(montantAffiche)}</span>
                <button class="icon-btn" data-action="del-charge-fixe" data-id="${c.id}">🗑️</button>
              </div>
              ${c.type === 'credit' ? `
                <div class="line-amounts">Capital restant dû : ${C.formatEUR(c.capitalRestant)}${!c.tauxAnnuel ? ' (estimation)' : ''}</div>
                ${jaugeCredit !== null ? `<div class="progress-track"><div class="progress-fill" style="width:${jaugeCredit}%; background:var(--charges-fixes-dark);"></div></div>` : ''}
              ` : `<div class="line-amounts">${c.recurrence === 'annuel' ? 'Annuel, lissé : ' + C.formatEUR(c.montant / 12) + ' / mois' : 'Mensuel'}</div>`}
              ${libreActif ? `
                <div class="line-amounts" style="margin-top:6px;">👥 ${repartitionTexte}
                  <button class="btn btn-ghost" style="padding:2px 0 0; font-size:12px;" data-action="open-repartir-ligne" data-id="${c.id}">Modifier →</button>
                </div>` : ''}
            </div>`;
        }).join('')}
    </div>
    <button class="btn btn-primary btn-block" data-action="open-add-charge-fixe">+ Ajouter une charge fixe</button>`;
}
function toM(c) { return C.toMonthly(c.montant, c.recurrence); }

function sheetRepartirLigne(id) {
  const c = cache.chargesFixes.find((x) => x.id === id);
  const n = cache.profiles.length || 1;
  return `${sheetHeader(`Répartir — ${c ? escapeHTML(c.nom) : ''}`)}
    <p style="font-size:12.5px; color:var(--text-soft); margin-bottom:14px;">Indique le pourcentage de cette charge payé par chaque personne. Le total doit faire 100%.</p>
    <form data-action="submit-repartir-ligne" data-id="${id}">
      ${cache.profiles.map((p) => {
        const pct = c && c.repartitionLibre && c.repartitionLibre[p.id] != null ? c.repartitionLibre[p.id] : 100 / n;
        return `
        <div class="field">
          <label>${escapeHTML(p.nom)}</label>
          <input name="pct_${p.id}" type="number" step="1" min="0" max="100" value="${Math.round(pct)}" inputmode="numeric" />
        </div>`;
      }).join('')}
      <button class="btn btn-primary btn-block" type="submit">Enregistrer</button>
    </form>`;
}

function sheetAddChargeFixe() {
  return `${sheetHeader('Ajouter une charge fixe')}
    <form data-action="submit-charge-fixe">
      <div class="field">
        <label>Type de ligne</label>
        <select name="type" id="charge-type-select">
          <option value="normal">Charge classique</option>
          <option value="credit">Crédit immobilier</option>
        </select>
      </div>
      <div class="field">
        <label>Nom</label>
        <input name="nom" placeholder="Ex : Loyer, Assurance auto..." required />
      </div>
      <div id="charge-normal-fields">
        <div class="field">
          <label>Catégorie</label>
          <select name="categorie">
            <option value="loyer">🏠 Loyer</option>
            <option value="assurance">🛡️ Assurance</option>
            <option value="abonnement">📺 Abonnement</option>
            <option value="energie">⚡ Énergie</option>
            <option value="autre">➕ Autre</option>
          </select>
        </div>
        <div class="field-row">
          <div class="field">
            <label>Montant</label>
            <input name="montant" type="number" step="0.01" min="0" placeholder="0" inputmode="decimal" />
          </div>
          <div class="field">
            <label>Récurrence</label>
            <select name="recurrence">
              <option value="mensuel">Mensuel</option>
              <option value="annuel">Annuel (lissé)</option>
            </select>
          </div>
        </div>
      </div>
      <div id="charge-credit-fields" style="display:none;">
        <div class="field">
          <label>Capital restant dû actuel</label>
          <input name="capitalRestant" type="number" step="0.01" min="0" placeholder="0" inputmode="decimal" />
        </div>
        <div class="field">
          <label>Mensualité</label>
          <input name="mensualite" type="number" step="0.01" min="0" placeholder="0" inputmode="decimal" />
        </div>
        <div class="field">
          <label>Taux d'intérêt annuel (optionnel)</label>
          <input name="tauxAnnuel" type="number" step="0.01" min="0" placeholder="Ex : 3.2" inputmode="decimal" />
          <p style="font-size:12px; color:var(--text-soft); margin-top:6px;">Sans taux, la baisse du capital sera estimée de façon simplifiée.</p>
        </div>
      </div>
      <button class="btn btn-primary btn-block" type="submit">Enregistrer</button>
    </form>`;
}

function moisPrecedent(mois) {
  const [y, m] = mois.split('-').map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function renderChargesVariables() {
  const mois = C.currentMonthKey();
  const moisPrec = moisPrecedent(mois);
  return `
    <div class="card">
      ${cache.categoriesVariables.length === 0 ? emptyState('🛒', "Crée des catégories pour suivre tes dépenses du quotidien : courses, essence, loisirs...") :
        cache.categoriesVariables.map((cat) => {
          const depenses = cache.depensesVariables.filter((d) => d.categorieId === cat.id && d.date.slice(0, 7) === mois);
          const depense = depenses.reduce((s, d) => s + d.montant, 0);
          const depensePrec = cache.depensesVariables.filter((d) => d.categorieId === cat.id && d.date.slice(0, 7) === moisPrec).reduce((s, d) => s + d.montant, 0);
          const solde = cat.budgetPrevisionnel - depense;
          const pct = cat.budgetPrevisionnel > 0 ? Math.min(100, (depense / cat.budgetPrevisionnel) * 100) : 0;
          const comparatif = depensePrec > 0 ? comparaisonTexteCategorie(depense, depensePrec) : '';
          return `
            <div class="line-item">
              <div class="line-head">
                <span class="line-icon">${cat.icone || '🛒'}</span>
                <span class="line-name">${escapeHTML(cat.nom)}</span>
                <button class="fab" style="background:var(--charges-var-dark);" data-action="open-quick-add" data-id="${cat.id}">+</button>
                <button class="icon-btn" data-action="open-edit-categorie-var" data-id="${cat.id}">✏️</button>
              </div>
              <div class="line-amounts">
                ${C.formatEUR(depense)} dépensés sur ${C.formatEUR(cat.budgetPrevisionnel)} prévus —
                ${solde >= 0 ? `reste ${C.formatEUR(solde)}` : `<b style="color:var(--alerte-dark);">dépassement de ${C.formatEUR(-solde)}</b>`}
                ${comparatif}
              </div>
              <div class="progress-track">
                <div class="progress-fill" style="width:${pct}%; background:${solde >= 0 ? 'var(--charges-var-dark)' : 'var(--alerte-dark)'};"></div>
              </div>
              ${depenses.length > 0 ? `<button class="btn btn-ghost" style="padding:6px 0 0; font-size:12px;" data-action="open-journal" data-id="${cat.id}">Voir le détail (${depenses.length}) →</button>` : ''}
            </div>`;
        }).join('')}
    </div>
    <button class="btn btn-primary btn-block" data-action="open-add-categorie-var">+ Ajouter une catégorie</button>`;
}

function comparaisonTexteCategorie(actuel, precedent) {
  const diff = actuel - precedent;
  const pct = Math.round((diff / precedent) * 100);
  if (Math.abs(pct) < 3) return ' · stable vs mois dernier';
  return diff < 0 ? ` · <span style="color:var(--revenus-dark);">${Math.abs(pct)}% de moins que le mois dernier</span>` : ` · <span style="color:var(--charges-var-dark);">${pct}% de plus que le mois dernier</span>`;
}

function sheetAddCategorieVar(existing) {
  const c = existing;
  return `${sheetHeader(c ? 'Modifier la catégorie' : 'Nouvelle catégorie de dépenses')}
    <form data-action="${c ? 'submit-edit-categorie-var' : 'submit-categorie-var'}" ${c ? `data-id="${c.id}"` : ''}>
      <div class="field">
        <label>Nom</label>
        <input name="nom" value="${c ? escapeHTML(c.nom) : ''}" placeholder="Ex : Courses, Essence, Loisirs..." required />
      </div>
      <div class="field">
        <label>Icône</label>
        <select name="icone">
          ${['🛒', '⛽', '🎉', '👕', '💊', '➕'].map((i) => `<option value="${i}" ${c && c.icone === i ? 'selected' : ''}>${i}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>Budget prévisionnel mensuel</label>
        <input name="budgetPrevisionnel" type="number" step="0.01" min="0" value="${c ? c.budgetPrevisionnel : ''}" placeholder="0" required inputmode="decimal" />
        <p style="font-size:12px; color:var(--text-soft); margin-top:6px;">Ce montant reste d'un mois sur l'autre — pas besoin de le ressaisir chaque mois.</p>
      </div>
      <button class="btn btn-primary btn-block" type="submit">${c ? 'Enregistrer' : 'Créer la catégorie'}</button>
      ${c ? `<button class="btn btn-danger btn-block" style="margin-top:10px;" type="button" data-action="del-categorie-var" data-id="${c.id}">Supprimer la catégorie</button>` : ''}
    </form>`;
}

function sheetQuickAdd(categorieId) {
  const cat = cache.categoriesVariables.find((c) => c.id === categorieId);
  return `${sheetHeader(`Dépense — ${cat ? escapeHTML(cat.nom) : ''}`)}
    <form data-action="submit-quick-add" data-categorie-id="${categorieId}">
      <div class="field">
        <label>Montant</label>
        <input name="montant" type="number" step="0.01" min="0" placeholder="0" required inputmode="decimal" autofocus />
      </div>
      <div class="field">
        <label>Note (optionnel)</label>
        <input name="note" placeholder="Ex : Supermarché du samedi" />
      </div>
      <div class="field">
        <label>Tags (optionnel, séparés par des virgules)</label>
        <input name="tags" placeholder="Ex : Vacances Portugal" />
      </div>
      <button class="btn btn-primary btn-block" type="submit">Enregistrer la dépense</button>
    </form>`;
}

function sheetJournal(categorieId) {
  const cat = cache.categoriesVariables.find((c) => c.id === categorieId);
  const mois = C.currentMonthKey();
  const depenses = cache.depensesVariables
    .filter((d) => d.categorieId === categorieId && d.date.slice(0, 7) === mois)
    .sort((a, b) => b.date.localeCompare(a.date));
  return `${sheetHeader(`Détail — ${cat ? escapeHTML(cat.nom) : ''}`)}
    ${depenses.map((d) => `
      <div class="line-item">
        <div class="line-head">
          <span class="line-name" style="font-size:13px;">${d.note ? escapeHTML(d.note) : new Date(d.date).toLocaleDateString('fr-FR')}</span>
          <span style="font-weight:700;">${C.formatEUR(d.montant)}</span>
          <button class="icon-btn" data-action="del-depense-variable" data-id="${d.id}" data-categorie-id="${categorieId}">🗑️</button>
        </div>
        <div class="line-amounts">
          ${new Date(d.date).toLocaleDateString('fr-FR')}
          ${(d.tags || []).map((t) => `<span class="tag" style="background:var(--charges-var); margin-left:4px;">${escapeHTML(t)}</span>`).join('')}
        </div>
      </div>`).join('')}
  `;
}

// ===================== PRÉVOYANCE (enveloppes) =====================
const PRESETS_ENVELOPPE = [
  { nom: 'Vétérinaire', icone: '🐾' },
  { nom: 'Alimentation animale', icone: '🦴' },
  { nom: 'Entretien voiture', icone: '🚗' },
  { nom: 'Cadeaux (Noël, anniversaires)', icone: '🎁' },
  { nom: 'Impôts', icone: '📋' },
  { nom: 'Dentiste / optique', icone: '🦷' },
];

function renderPrevoyance() {
  const total = C.sumProvisionsEnveloppes(cache.enveloppes);
  const mois = C.currentMonthKey();
  return `
    ${topbar('Prévoyance', total > 0 ? `${C.formatEUR(total)} à provisionner / mois` : "Pour lisser les dépenses irrégulières")}
    <div class="screen" style="padding-top:6px;">
      ${cache.enveloppes.length === 0 ? `
        <div class="card">
          ${emptyState('🧺', "Les enveloppes de prévoyance te permettent de mettre un peu d'argent de côté chaque mois pour des dépenses qui reviennent, mais pas tous les mois : vétérinaire, voiture, impôts, cadeaux...")}
        </div>
        <div class="card">
          <h2 style="font-size:14px; margin-bottom:10px;">Modèles courants</h2>
          <div style="display:flex; flex-wrap:wrap; gap:8px;">
            ${PRESETS_ENVELOPPE.map((p) => `
              <button class="tag" style="background:var(--prevoyance); color:#5A4B1F; padding:8px 12px; font-size:12.5px;" data-action="open-add-enveloppe" data-preset-nom="${escapeHTML(p.nom)}" data-preset-icone="${p.icone}">${p.icone} ${escapeHTML(p.nom)}</button>
            `).join('')}
          </div>
        </div>
      ` : `
        <div class="card">
          ${cache.enveloppes.map((env) => renderEnveloppeLigne(env, mois)).join('')}
        </div>
      `}
      <button class="btn btn-primary btn-block" data-action="open-add-enveloppe">+ Nouvelle enveloppe</button>
    </div>`;
}

function renderEnveloppeLigne(env, mois) {
  const objectif = env.montantCible || 0;
  const accumule = env.montantAccumule || 0;
  const pct = objectif > 0 ? Math.min(100, (accumule / objectif) * 100) : 0;
  const provisionMois = C.provisionMensuelle(env);
  const dejaProvisionne = (env.provisionsFaites || []).includes(mois);
  const cycleComplet = objectif > 0 && accumule >= objectif;
  return `
    <div class="line-item">
      <div class="line-head">
        <span class="line-icon">${env.icone || '🧺'}</span>
        <span class="line-name">${escapeHTML(env.nom)}</span>
        <button class="fab" style="background:var(--prevoyance-dark);" data-action="open-quick-add-enveloppe" data-id="${env.id}">+</button>
        <button class="icon-btn" data-action="del-enveloppe" data-id="${env.id}">🗑️</button>
      </div>
      <div class="line-amounts">
        Disponible : <b>${C.formatEUR(accumule)}</b> / ${C.formatEUR(objectif)} objectif
        ${provisionMois > 0 ? ` · provision ${C.formatEUR(provisionMois)}/mois` : ''}
      </div>
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%; background:var(--prevoyance-dark);"></div></div>
      <div style="display:flex; gap:8px; margin-top:8px; align-items:center;">
        ${cycleComplet && env.recurrente ? `
          <button class="btn btn-secondary" style="flex:1; font-size:12.5px; padding:8px;" data-action="reset-enveloppe" data-id="${env.id}">🔄 Nouveau cycle</button>
        ` : `
          <button class="btn btn-secondary" style="flex:1; font-size:12.5px; padding:8px;" ${dejaProvisionne ? 'disabled style="opacity:0.5;"' : ''} data-action="provisionner-enveloppe" data-id="${env.id}">
            ${dejaProvisionne ? '✓ Provisionné ce mois' : `Provisionner ce mois (${C.formatEUR(provisionMois)})`}
          </button>
        `}
      </div>
    </div>`;
}

function sheetAddEnveloppe(presetNom, presetIcone) {
  return `${sheetHeader('Nouvelle enveloppe de prévoyance')}
    <form data-action="submit-add-enveloppe">
      <div class="field">
        <label>Nom</label>
        <input name="nom" value="${presetNom ? escapeHTML(presetNom) : ''}" placeholder="Ex : Vétérinaire, Impôts..." required />
      </div>
      <div class="field">
        <label>Icône</label>
        <select name="icone">
          ${['🧺','🐾','🦴','🚗','🎁','📋','🦷','🏠','✈️','💻'].map((i) => `<option value="${i}" ${presetIcone === i ? 'selected' : ''}>${i}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>Montant cible</label>
        <input name="montantCible" type="number" step="0.01" min="0" placeholder="0" required inputmode="decimal" />
      </div>
      <div class="field">
        <label>Durée de lissage</label>
        <select name="dureePreset" id="duree-preset-select">
          <option value="1">Mensuel</option>
          <option value="2">Bimestriel</option>
          <option value="3">Trimestriel</option>
          <option value="6">Semestriel</option>
          <option value="12" selected>Annuel</option>
          <option value="custom">Personnalisé</option>
        </select>
      </div>
      <div class="field" id="duree-custom-field" style="display:none;">
        <label>Nombre de mois</label>
        <input name="dureeCustom" type="number" step="1" min="1" placeholder="Ex : 8" />
      </div>
      <div class="field">
        <label>Déjà mis de côté (optionnel)</label>
        <input name="montantAccumule" type="number" step="0.01" min="0" placeholder="0" inputmode="decimal" />
      </div>
      <div class="field">
        <label>Type</label>
        <select name="recurrente">
          <option value="true">Récurrente — se réinitialise à chaque cycle terminé</option>
          <option value="false">Ponctuelle — pas de reset après la dépense</option>
        </select>
      </div>
      <button class="btn btn-primary btn-block" type="submit">Créer l'enveloppe</button>
    </form>`;
}

function sheetQuickAddEnveloppe(id) {
  const env = cache.enveloppes.find((e) => e.id === id);
  const disponible = env ? env.montantAccumule : 0;
  return `${sheetHeader(`Dépense — ${env ? escapeHTML(env.nom) : ''}`)}
    <p style="font-size:12.5px; color:var(--text-soft); margin-bottom:12px;">Disponible dans l'enveloppe : ${C.formatEUR(disponible)}</p>
    <form data-action="submit-quick-add-enveloppe" data-id="${id}">
      <div class="field">
        <label>Montant</label>
        <input name="montant" type="number" step="0.01" min="0" placeholder="0" required inputmode="decimal" autofocus />
      </div>
      <div class="field">
        <label>Note (optionnel)</label>
        <input name="note" placeholder="Ex : Vaccin annuel" />
      </div>
      <button class="btn btn-primary btn-block" type="submit">Enregistrer la dépense</button>
    </form>`;
}

// ===================== ÉPARGNE =====================
function renderEpargne() {
  const matelas = cache.epargne.find((e) => e.type === 'matelas');
  const projets = cache.epargne.filter((e) => e.type === 'projet');
  const invest = cache.epargne.find((e) => e.type === 'investissement');

  return `
    ${topbar('Épargne')}
    <div class="screen" style="padding-top:6px;">
      <div class="card">
        <h2 style="font-size:15px;">🌱 Matelas de sécurité</h2>
        ${matelas ? `
          <p style="font-size:13px; color:var(--text-soft); margin-top:4px;">${C.formatEUR(matelas.montantAccumule)} / ${C.formatEUR(matelas.objectif)}</p>
          <div class="progress-track"><div class="progress-fill" style="width:${matelas.objectif > 0 ? Math.min(100, (matelas.montantAccumule / matelas.objectif) * 100) : 0}%; background:var(--epargne-dark);"></div></div>
          ${matelas.montantAccumule >= matelas.objectif && matelas.objectif > 0 ? `<p style="margin-top:10px; font-size:13px;">Ton matelas de sécurité est complet 🎉</p>` : ''}
          <div style="display:flex; gap:8px; margin-top:12px;">
            <button class="btn btn-secondary" style="flex:1;" data-action="open-mouvement-epargne" data-id="${matelas.id}" data-type="depot">+ Dépôt</button>
            <button class="btn btn-secondary" style="flex:1;" data-action="open-mouvement-epargne" data-id="${matelas.id}" data-type="retrait">− Retrait</button>
          </div>
        ` : `
          <p style="font-size:13px; color:var(--text-soft); margin-top:4px;">Ton matelas te met à l'abri des imprévus.</p>
          <button class="btn btn-primary btn-block" style="margin-top:12px;" data-action="open-init-matelas">Configurer mon matelas</button>
        `}
      </div>

      <div class="card">
        <div style="display:flex; align-items:center;">
          <h2 style="font-size:15px; flex:1;">🎯 Projets d'épargne</h2>
          <button class="fab" style="background:var(--epargne-dark);" data-action="open-add-projet">+</button>
        </div>
        ${projets.length === 0 ? `<p style="font-size:13px; color:var(--text-soft); margin-top:6px;">Noël, vacances, apport immobilier... Crée un projet pour mettre de l'argent de côté.</p>` :
          projets.map((p) => `
            <div class="line-item">
              <div class="line-head">
                <span class="line-name">${escapeHTML(p.nom)}</span>
                <button class="icon-btn" data-action="del-epargne" data-id="${p.id}">🗑️</button>
              </div>
              <div class="line-amounts">${C.formatEUR(p.montantAccumule)} / ${C.formatEUR(p.objectif)}${p.compteAssocie ? ' · ' + escapeHTML(p.compteAssocie) : ''}</div>
              <div class="progress-track"><div class="progress-fill hatched" style="width:${p.objectif > 0 ? Math.min(100, (p.montantAccumule / p.objectif) * 100) : 0}%; color:var(--epargne-dark);"></div></div>
              <div style="display:flex; gap:8px; margin-top:8px;">
                <button class="btn btn-secondary" style="flex:1; font-size:13px; padding:8px;" data-action="open-mouvement-epargne" data-id="${p.id}" data-type="depot">+ Dépôt</button>
                <button class="btn btn-secondary" style="flex:1; font-size:13px; padding:8px;" data-action="open-mouvement-epargne" data-id="${p.id}" data-type="retrait">− Retrait</button>
              </div>
            </div>`).join('')}
      </div>

      <div class="card">
        <h2 style="font-size:15px;">📈 Épargne / investissement</h2>
        ${matelas && matelas.montantAccumule < matelas.objectif ? `<p style="font-size:12.5px; color:var(--text-soft); margin-top:6px;">On te conseille de terminer ton matelas de sécurité avant d'investir davantage — ce n'est pas bloquant, juste une suggestion.</p>` : ''}
        <p style="font-size:13px; color:var(--text-soft); margin-top:6px;">${invest ? C.formatEUR(invest.montantAccumule) + ' investis' : "Pas encore configuré."}</p>
        <button class="btn btn-secondary btn-block" style="margin-top:10px;" data-action="open-init-invest">${invest ? 'Gérer' : 'Configurer'}</button>
      </div>
    </div>`;
}

function sheetInitMatelas() {
  const foyer = cache.foyer || {};
  const revenusMensuel = C.sumRevenusMensuels(cache.revenus);
  const moisConseilles = foyer.typeRevenus === 'irregulier' ? 6 : 3;
  const objectifSuggere = Math.round(revenusMensuel * moisConseilles);
  return `${sheetHeader('Configurer le matelas de sécurité')}
    <form data-action="submit-init-matelas">
      <p style="font-size:13px; color:var(--text-soft); margin-bottom:14px;">
        On te suggère ${moisConseilles} mois de revenus (${C.formatEUR(objectifSuggere)}), modifiable à tout moment.
      </p>
      <div class="field">
        <label>Objectif</label>
        <input name="objectif" type="number" step="0.01" min="0" value="${objectifSuggere}" required inputmode="decimal" />
      </div>
      <div class="field">
        <label>As-tu déjà de l'épargne de côté ?</label>
        <input name="montantAccumule" type="number" step="0.01" min="0" placeholder="0" inputmode="decimal" />
      </div>
      <button class="btn btn-primary btn-block" type="submit">Créer mon matelas</button>
    </form>`;
}

function sheetAddProjet() {
  return `${sheetHeader("Nouveau projet d'épargne")}
    <form data-action="submit-add-projet">
      <div class="field">
        <label>Nom du projet</label>
        <input name="nom" placeholder="Ex : Vacances d'été, Noël..." required />
      </div>
      <div class="field">
        <label>Montant cible</label>
        <input name="objectif" type="number" step="0.01" min="0" placeholder="0" required inputmode="decimal" />
      </div>
      <div class="field">
        <label>Déjà mis de côté (optionnel)</label>
        <input name="montantAccumule" type="number" step="0.01" min="0" placeholder="0" inputmode="decimal" />
      </div>
      <div class="field">
        <label>Compte associé (optionnel)</label>
        <input name="compteAssocie" placeholder="Ex : Livret A, cagnotte..." />
      </div>
      <p style="font-size:12px; color:var(--text-soft); margin-bottom:14px;">
        Astuce : sépare physiquement cet argent de ton matelas de sécurité, via un second livret ou une cagnotte dédiée, pour éviter d'y puiser par erreur.
      </p>
      <button class="btn btn-primary btn-block" type="submit">Créer le projet</button>
    </form>`;
}

function sheetInitInvest() {
  const invest = cache.epargne.find((e) => e.type === 'investissement');
  return `${sheetHeader('Épargne / investissement')}
    <form data-action="submit-init-invest">
      <div class="field">
        <label>Montant déjà investi</label>
        <input name="montantAccumule" type="number" step="0.01" min="0" value="${invest ? invest.montantAccumule : 0}" inputmode="decimal" />
      </div>
      <button class="btn btn-primary btn-block" type="submit">Enregistrer</button>
    </form>`;
}

function sheetMouvementEpargne(id, type) {
  const e = cache.epargne.find((x) => x.id === id);
  const titre = type === 'depot' ? 'Ajouter un dépôt' : 'Enregistrer un retrait';
  return `${sheetHeader(`${titre} — ${e ? escapeHTML(e.nom) : ''}`)}
    <form data-action="submit-mouvement-epargne" data-id="${id}" data-type="${type}">
      <div class="field">
        <label>Montant</label>
        <input name="montant" type="number" step="0.01" min="0" placeholder="0" required inputmode="decimal" autofocus />
      </div>
      <button class="btn btn-primary btn-block" type="submit">${titre}</button>
    </form>`;
}

// ===================== RÉGLAGES =====================
function renderSettings() {
  const modeLabels = {
    egales: ['Parts égales', "Chacun paie une part identique de chaque charge commune, quel que soit son revenu."],
    prorata: ['Prorata des revenus', "Chacun contribue proportionnellement à son revenu."],
    equitable: ['Équitable (pot commun)', "Tous les revenus rejoignent un pot commun ; le reste est partagé à parts égales."],
    libre: ['Libre', "Tu répartis chaque ligne toi-même."],
  };
  return `
    ${topbar('Réglages', null, { hideSettings: true })}
    <div class="screen" style="padding-top:6px;">
      <div class="card">
        <h2 style="font-size:15px;">👥 Profils du foyer</h2>
        ${cache.profiles.length === 0 ? `
          <p style="font-size:12.5px; color:var(--text-soft); margin:6px 0 12px;">Tu gères ton budget seul·e pour l'instant. Ajoute des profils si vous êtes plusieurs à partager ce budget.</p>
        ` : `
          <div style="margin:10px 0;">
            ${cache.profiles.map((p) => `
              <div class="line-item" style="padding:8px 0;">
                <div class="line-head" style="margin-bottom:0;">
                  <span class="line-name" style="font-size:13px;">${escapeHTML(p.nom)}</span>
                  <button class="icon-btn" data-action="del-profile" data-id="${p.id}">🗑️</button>
                </div>
              </div>`).join('')}
          </div>
        `}
        <button class="btn btn-secondary btn-block" data-action="open-add-profile">+ Ajouter une personne</button>
        ${cache.profiles.length > 1 ? `
          <h2 style="font-size:14px; margin-top:18px;">Mode de répartition</h2>
          <div class="choice-list" style="margin-top:10px;">
            ${Object.entries(modeLabels).map(([key, [t, d]]) => `
              <button class="choice-card ${cache.repartitionMode === key ? 'selected' : ''}" data-action="set-repartition-mode" data-mode="${key}">
                <div class="choice-title">${t}</div>
                <div class="choice-desc">${d}</div>
              </button>`).join('')}
          </div>
        ` : ''}
      </div>

      <div class="card">
        <h2 style="font-size:15px;">Sauvegarde</h2>
        <p style="font-size:12.5px; color:var(--text-soft); margin:6px 0 12px;">Tout est stocké uniquement sur cet appareil. Exporte régulièrement une sauvegarde pour ne rien perdre.</p>
        <button class="btn btn-secondary btn-block" data-action="export-json">Exporter mes données (JSON)</button>
        <label class="btn btn-secondary btn-block" style="margin-top:10px; display:block; text-align:center;">
          Importer une sauvegarde
          <input type="file" accept="application/json" data-action="import-json" style="display:none;" />
        </label>
      </div>

      <div class="card">
        <h2 style="font-size:15px;">📖 Comprendre son budget</h2>
        <p style="font-size:12.5px; color:var(--text-soft); margin:6px 0 12px;">Fiches simples sur le reste à vivre, la méthode 50/30/20, le matelas de sécurité...</p>
        <button class="btn btn-secondary btn-block" data-action="go" data-route="pedagogie">Ouvrir l'espace pédagogique</button>
      </div>

      <div class="card">
        <h2 style="font-size:15px;">🧮 Simuler un changement</h2>
        <p style="font-size:12.5px; color:var(--text-soft); margin:6px 0 12px;">Teste l'impact d'un changement (loyer, revenu...) sans toucher à tes vraies données.</p>
        <button class="btn btn-secondary btn-block" data-action="go" data-route="simulation">Ouvrir le simulateur</button>
      </div>

      <div class="card">
        <h2 style="font-size:15px;">Apparence</h2>
        <button class="btn btn-secondary btn-block" style="margin-top:10px;" data-action="toggle-dark">🌙 Mode sombre / clair</button>
      </div>
      <div class="card">
        <h2 style="font-size:15px;">Revoir l'introduction</h2>
        <button class="btn btn-secondary btn-block" style="margin-top:10px;" data-action="replay-onboarding">Revoir le tutoriel</button>
      </div>
      <div class="card">
        <h2 style="font-size:15px; color:var(--alerte-dark);">Zone danger</h2>
        <button class="btn btn-danger btn-block" style="margin-top:10px; border:1.5px solid var(--alerte);" data-action="wipe-data">Réinitialiser toutes les données</button>
      </div>
    </div>`;
}

function sheetAddProfile() {
  return `${sheetHeader('Ajouter une personne')}
    <form data-action="submit-add-profile">
      <div class="field">
        <label>Prénom</label>
        <input name="nom" placeholder="Ex : Camille" required autofocus />
      </div>
      <button class="btn btn-primary btn-block" type="submit">Ajouter</button>
    </form>`;
}

function emptyState(icon, text) {
  return `<div class="empty-state"><div class="empty-icon">${icon}</div><p>${text}</p></div>`;
}
function escapeHTML(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

// ===================== HISTORIQUE =====================
const METRIQUES_CONFIG = {
  resteAVivre: { label: 'Reste à vivre', color: 'var(--revenus-dark)', hex: '#6FA989' },
  revenusMensuel: { label: 'Revenus', color: 'var(--revenus-dark)', hex: '#6FA989' },
  chargesFixesMensuel: { label: 'Charges fixes', color: 'var(--charges-fixes-dark)', hex: '#6E93C0' },
  depensesVarMois: { label: 'Dépenses courantes', color: 'var(--charges-var-dark)', hex: '#D98A6C' },
  provisionsMois: { label: 'Prévoyance', color: 'var(--prevoyance-dark)', hex: '#C4A968' },
};

function renderHistorique() {
  const annee = state.historiqueAnnee;
  const mois = C.currentMonthKey();
  const parAn = {};
  cache.monthlyHistory.forEach((h) => { parAn[h.mois] = h; });

  const moisAnnee = Array.from({ length: 12 }, (_, i) => {
    const key = `${annee}-${String(i + 1).padStart(2, '0')}`;
    return parAn[key] || null;
  });

  const moisActuel = parAn[mois];
  const cleAnDernier = `${parseInt(mois.slice(0, 4), 10) - 1}-${mois.slice(5, 7)}`;
  const moisAnDernier = parAn[cleAnDernier];

  const metriquesActives = Object.keys(state.historiqueMetriques).filter((k) => state.historiqueMetriques[k]);
  const chart = buildLineChartSVG(moisAnnee, metriquesActives);

  return `
    ${topbar('Historique')}
    <div class="screen" style="padding-top:6px;">
      <div class="card">
        <div style="display:flex; align-items:center; justify-content:center; gap:16px; margin-bottom:12px;">
          <button class="icon-btn" data-action="historique-year" data-delta="-1">←</button>
          <b style="font-size:16px;">${annee}</b>
          <button class="icon-btn" data-action="historique-year" data-delta="1">→</button>
        </div>
        ${chart}
        <div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:12px;">
          ${Object.entries(METRIQUES_CONFIG).map(([key, cfg]) => `
            <button class="tag" style="background:${state.historiqueMetriques[key] ? cfg.color : '#EFEAE0'}; color:${state.historiqueMetriques[key] ? '#FFF' : 'var(--text-soft)'}; padding:6px 10px;" data-action="toggle-metrique" data-metrique="${key}">${cfg.label}</button>
          `).join('')}
        </div>
      </div>

      ${moisActuel && moisAnDernier ? `
        <div class="card">
          <h2 style="font-size:14px;">Ce mois-ci vs ${C.moisLisible(cleAnDernier)}</h2>
          <p style="font-size:13px; margin-top:8px;">
            Reste à vivre : ${C.formatEUR(moisActuel.resteAVivre)} contre ${C.formatEUR(moisAnDernier.resteAVivre)}
            ${comparaisonTexte(moisActuel.resteAVivre, moisAnDernier.resteAVivre)}
          </p>
        </div>
      ` : ''}

      ${renderCinquanteTrenteVingt()}
      ${renderPatrimoine()}

      <div class="card">
        <h2 style="font-size:15px;">📄 Bilans mensuels</h2>
        <p style="font-size:12.5px; color:var(--text-soft); margin:6px 0 10px;">Exporte un bilan propre à archiver ou à montrer à un conseiller.</p>
        <button class="btn btn-secondary btn-block" data-action="print-bilan" data-mois="${mois}">Exporter le bilan de ${C.moisLisible(mois)} (PDF)</button>
      </div>
    </div>`;
}

function comparaisonTexte(actuel, precedent) {
  if (!precedent) return '';
  const diff = actuel - precedent;
  const pct = precedent !== 0 ? Math.round((diff / Math.abs(precedent)) * 100) : 0;
  if (Math.abs(pct) < 1) return ' (stable)';
  return diff > 0 ? ` (+${pct}%, mieux qu'avant)` : ` (${pct}%, à surveiller)`;
}

function buildLineChartSVG(moisAnnee, metriques) {
  if (metriques.length === 0) {
    return `<div class="empty-state" style="padding:24px 10px;"><p>Choisis au moins une donnée à afficher ci-dessous.</p></div>`;
  }
  const W = 300, H = 160, padL = 8, padR = 8, padT = 10, padB = 22;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  let maxVal = 10;
  metriques.forEach((m) => moisAnnee.forEach((d) => { if (d && Math.abs(d[m] || 0) > maxVal) maxVal = Math.abs(d[m]); }));
  maxVal *= 1.15;

  const x = (i) => padL + (plotW / 11) * i;
  const y = (v) => padT + plotH / 2 - (v / maxVal) * (plotH / 2);

  const zeroY = y(0);
  const lines = metriques.map((m) => {
    const cfg = METRIQUES_CONFIG[m];
    let d = '';
    let started = false;
    moisAnnee.forEach((data, i) => {
      if (!data || data[m] === undefined) { started = false; return; }
      const cmd = started ? 'L' : 'M';
      d += `${cmd}${x(i).toFixed(1)},${y(data[m]).toFixed(1)} `;
      started = true;
    });
    const dots = moisAnnee.map((data, i) => (data && data[m] !== undefined) ? `<circle cx="${x(i).toFixed(1)}" cy="${y(data[m]).toFixed(1)}" r="2.5" fill="${cfg.hex}"/>` : '').join('');
    return `<path d="${d.trim()}" fill="none" stroke="${cfg.hex}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>${dots}`;
  }).join('');

  const moisLabels = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
  const labels = moisLabels.map((l, i) => `<text x="${x(i).toFixed(1)}" y="${H - 6}" font-size="9" fill="#B4B2A9" text-anchor="middle">${l}</text>`).join('');

  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%; height:auto;">
    <line x1="${padL}" y1="${zeroY.toFixed(1)}" x2="${W - padR}" y2="${zeroY.toFixed(1)}" stroke="#E5E0D5" stroke-width="1"/>
    ${lines}
    ${labels}
  </svg>`;
}

function renderCinquanteTrenteVingt() {
  const mois = C.currentMonthKey();
  const revenusMensuel = C.sumRevenusMensuels(cache.revenus);
  if (revenusMensuel <= 0) return '';
  const chargesFixesMensuel = C.sumChargesFixesMensuelles(cache.chargesFixes);
  const provisionsMois = C.sumProvisionsEnveloppes(cache.enveloppes);
  const depensesVarMois = C.sumDepensesVariablesDuMois(cache.depensesVariables, mois);
  const depotsEpargneMois = cache.mouvementsEpargne
    .filter((m) => m.type === 'depot' && m.date.slice(0, 7) === mois)
    .reduce((s, m) => s + m.montant, 0);

  const besoins = chargesFixesMensuel;
  const envies = depensesVarMois;
  const epargne = provisionsMois + depotsEpargneMois;
  const rows = [
    ['Besoins essentiels', besoins, 50, 'var(--charges-fixes-dark)'],
    ['Envies', envies, 30, 'var(--charges-var-dark)'],
    ['Épargne', epargne, 20, 'var(--epargne-dark)'],
  ];
  return `
      <div class="card">
        <h2 style="font-size:15px;">⚖️ Méthode 50/30/20</h2>
        <p style="font-size:12px; color:var(--text-soft); margin:4px 0 12px;">Vue indicative : 50% besoins, 30% envies, 20% épargne.</p>
        ${rows.map(([label, montant, cible, color]) => {
          const pctReel = Math.round((montant / revenusMensuel) * 100);
          return `
          <div class="line-item">
            <div class="line-head">
              <span class="line-name">${label}</span>
              <span style="font-size:12.5px; color:var(--text-soft);">${pctReel}% (cible ${cible}%)</span>
            </div>
            <div class="progress-track"><div class="progress-fill" style="width:${Math.min(100, pctReel)}%; background:${color};"></div></div>
          </div>`;
        }).join('')}
      </div>`;
}

function renderPatrimoine() {
  const credit = cache.chargesFixes.find((c) => c.type === 'credit');
  const hasEpargne = cache.epargne.length > 0;
  if (!credit && !hasEpargne) return '';
  const totalEpargne = cache.epargne.reduce((s, e) => s + (e.montantAccumule || 0), 0);
  const capitalRestant = credit ? credit.capitalRestant : 0;
  const patrimoine = totalEpargne - capitalRestant;
  return `
      <div class="card">
        <h2 style="font-size:15px;">🏦 Patrimoine net</h2>
        <p style="font-size:12px; color:var(--text-soft); margin:4px 0 10px;">Épargne totale moins capital restant dû.</p>
        <div class="gauge-value" style="font-size:24px; text-align:center;">${C.formatEUR(patrimoine)}</div>
        <p style="font-size:11.5px; color:var(--text-soft); text-align:center; margin-top:4px;">
          ${C.formatEUR(totalEpargne)} épargnés ${credit ? '− ' + C.formatEUR(capitalRestant) + ' restant dû' : ''}
        </p>
      </div>`;
}

// ===================== ESPACE PÉDAGOGIQUE =====================
const FICHES_PEDAGOGIQUES = [
  { titre: 'Le reste à vivre', texte: "C'est ce qu'il te reste chaque mois une fois payées tes charges fixes et tes dépenses courantes. Frugi le calcule aussi par unité de consommation (UC), pour comparer ta situation de façon plus juste selon la taille de ton foyer." },
  { titre: "L'unité de consommation (UC)", texte: "Une méthode simple pour comparer des foyers de tailles différentes : le premier adulte compte pour 1 UC, les autres personnes de 14 ans et plus pour 0,5 UC, et les enfants de moins de 14 ans pour 0,3 UC." },
  { titre: 'La méthode 50/30/20', texte: "Une règle simple pour répartir ses revenus : 50% pour les besoins essentiels (logement, factures...), 30% pour les envies (loisirs, sorties...) et 20% pour l'épargne. C'est une cible indicative, à adapter à ta situation." },
  { titre: 'Le matelas de sécurité', texte: "Une réserve d'argent qui te protège en cas d'imprévu (perte de revenu, réparation urgente...). On recommande généralement 3 mois de revenus si tes revenus sont stables, 6 mois s'ils sont irréguliers." },
  { titre: 'Les enveloppes de prévoyance', texte: "Une façon de lisser les dépenses qui reviennent mais pas tous les mois (vétérinaire, impôts, cadeaux...) : tu mets un peu de côté chaque mois pour ne jamais être pris au dépourvu." },
  { titre: "Le taux d'endettement", texte: "La part de tes revenus qui part dans le remboursement de crédits. On considère généralement qu'il est prudent de rester sous 33%, mais chaque situation est différente." },
];

function renderPedagogie() {
  return `
    ${topbar('Comprendre son budget')}
    <div class="screen" style="padding-top:6px;">
      ${FICHES_PEDAGOGIQUES.map((f) => `
        <div class="card">
          <h2 style="font-size:15px;">${f.titre}</h2>
          <p style="font-size:13px; color:var(--text-soft); margin-top:6px; line-height:1.55;">${f.texte}</p>
        </div>`).join('')}
    </div>`;
}

// ===================== EXPORT PDF (impression) =====================
function renderPrintBilan(mois) {
  const foyer = cache.foyer || { adultes: 1, ados14plus: 0, enfantsMoins14: 0 };
  const uc = C.calcUC(foyer);
  const isCurrent = mois === C.currentMonthKey();
  const snap = cache.monthlyHistory.find((h) => h.mois === mois);

  const revenusMensuel = isCurrent ? C.sumRevenusMensuels(cache.revenus) : (snap ? snap.revenusMensuel : 0);
  const chargesFixesMensuel = isCurrent ? C.sumChargesFixesMensuelles(cache.chargesFixes) : (snap ? snap.chargesFixesMensuel : 0);
  const depensesVarMois = isCurrent ? C.sumDepensesVariablesDuMois(cache.depensesVariables, mois) : (snap ? snap.depensesVarMois : 0);
  const provisionsMois = isCurrent ? C.sumProvisionsEnveloppes(cache.enveloppes) : (snap ? snap.provisionsMois : 0);
  const resteAVivre = revenusMensuel - chargesFixesMensuel - depensesVarMois - provisionsMois;

  return `
    <div style="max-width:480px; margin:0 auto; padding:28px 20px; font-family:'Quicksand', sans-serif; color:#4A4A4A;">
      <button class="btn btn-secondary no-print" style="margin-bottom:16px;" data-action="back-from-print">← Retour</button>
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:18px;">
        ${logoSVG(36)}
        <div><h1 style="font-size:20px; margin:0;">Frugi</h1><div style="font-size:12px; color:#8A8880;">Bilan de ${C.moisLisible(mois)}</div></div>
      </div>
      <table style="width:100%; border-collapse:collapse; font-size:14px;">
        <tr><td style="padding:8px 0; border-bottom:1px solid #E5E0D5;">Revenus</td><td style="padding:8px 0; border-bottom:1px solid #E5E0D5; text-align:right; font-weight:700;">${C.formatEUR(revenusMensuel)}</td></tr>
        <tr><td style="padding:8px 0; border-bottom:1px solid #E5E0D5;">Charges fixes</td><td style="padding:8px 0; border-bottom:1px solid #E5E0D5; text-align:right;">− ${C.formatEUR(chargesFixesMensuel)}</td></tr>
        <tr><td style="padding:8px 0; border-bottom:1px solid #E5E0D5;">Dépenses courantes</td><td style="padding:8px 0; border-bottom:1px solid #E5E0D5; text-align:right;">− ${C.formatEUR(depensesVarMois)}</td></tr>
        <tr><td style="padding:8px 0; border-bottom:1px solid #E5E0D5;">Provisions prévoyance</td><td style="padding:8px 0; border-bottom:1px solid #E5E0D5; text-align:right;">− ${C.formatEUR(provisionsMois)}</td></tr>
        <tr><td style="padding:12px 0; font-weight:700;">Reste à vivre</td><td style="padding:12px 0; text-align:right; font-weight:700; font-size:17px;">${C.formatEUR(resteAVivre)}</td></tr>
        <tr><td style="padding:8px 0; color:#8A8880; font-size:12px;">soit par unité de consommation</td><td style="padding:8px 0; text-align:right; color:#8A8880; font-size:12px;">${C.formatEUR(resteAVivre / uc)}</td></tr>
      </table>
      <p style="font-size:11px; color:#B4B2A9; margin-top:24px;">Généré par Frugi le ${new Date().toLocaleDateString('fr-FR')} — document personnel, à titre indicatif.</p>
    </div>
    <style>@media print { .no-print, .bottom-nav { display:none !important; } }</style>`;
}

// ===================== EVENTS =====================
app.addEventListener('click', async (e) => {
  const backdrop = e.target.closest('.sheet-backdrop');
  if (backdrop && !e.target.closest('[data-stop]')) { closeSheet(); return; }

  const t = e.target.closest('[data-action]');
  if (!t) return;
  const action = t.dataset.action;

  if (action === 'go') { go(t.dataset.route); if (t.dataset.tab) state.chargesTab = t.dataset.tab; return; }
  if (action === 'close-sheet') { closeSheet(); return; }
  if (action === 'charges-tab') { state.chargesTab = t.dataset.tab; render(); return; }
  if (action === 'set-view-mode') { state.viewMode = t.dataset.mode; render(); return; }

  // Onboarding
  if (action === 'ob-next') { state.ob.step++; render(); return; }
  if (action === 'ob-inc') { state.ob[t.dataset.field]++; render(); return; }
  if (action === 'ob-dec') {
    const f = t.dataset.field;
    const min = f === 'adultes' ? 1 : 0;
    state.ob[f] = Math.max(min, state.ob[f] - 1);
    render(); return;
  }
  if (action === 'ob-set') { state.ob[t.dataset.field] = t.dataset.value; render(); return; }
  if (action === 'ob-finish') { await finishOnboarding(); return; }
  if (action === 'ob-next-noms') {
    const dflt = state.ob.nbProfilsChoice === 'deux' ? 2 : 2;
    if (state.ob.profils.length === 0) state.ob.profils = Array(dflt).fill('');
    state.ob.step = 4;
    render(); return;
  }
  if (action === 'ob-add-nom') { state.ob.profils.push(''); render(); return; }

  // Revenus
  if (action === 'open-add-revenu') { openSheet(sheetAddRevenu()); return; }
  if (action === 'del-revenu') { await db.delete('revenus', t.dataset.id); await reloadCache(); render(); return; }

  // Charges fixes
  if (action === 'open-add-charge-fixe') { openSheet(sheetAddChargeFixe()); return; }
  if (action === 'del-charge-fixe') { await db.delete('chargesFixes', t.dataset.id); await reloadCache(); render(); return; }
  if (action === 'open-repartir-ligne') { openSheet(sheetRepartirLigne(t.dataset.id)); return; }

  // Charges variables
  if (action === 'open-add-categorie-var') { openSheet(sheetAddCategorieVar()); return; }
  if (action === 'open-quick-add') { openSheet(sheetQuickAdd(t.dataset.id)); return; }
  if (action === 'open-edit-categorie-var') {
    const cat = cache.categoriesVariables.find((c) => c.id === t.dataset.id);
    openSheet(sheetAddCategorieVar(cat)); return;
  }
  if (action === 'del-categorie-var') {
    if (confirm("Supprimer cette catégorie ? Les dépenses déjà enregistrées resteront dans ton historique.")) {
      await db.delete('categoriesVariables', t.dataset.id);
      await reloadCache(); closeSheet(); go('charges');
    }
    return;
  }
  if (action === 'open-journal') { openSheet(sheetJournal(t.dataset.id)); return; }
  if (action === 'del-depense-variable') {
    await db.delete('depensesVariables', t.dataset.id);
    await reloadCache();
    openSheet(sheetJournal(t.dataset.categorieId));
    return;
  }

  // Prévoyance
  if (action === 'open-add-enveloppe') { openSheet(sheetAddEnveloppe(t.dataset.presetNom, t.dataset.presetIcone)); return; }
  if (action === 'open-quick-add-enveloppe') { openSheet(sheetQuickAddEnveloppe(t.dataset.id)); return; }
  if (action === 'del-enveloppe') { await db.delete('enveloppes', t.dataset.id); await reloadCache(); render(); return; }
  if (action === 'provisionner-enveloppe') {
    const env = cache.enveloppes.find((x) => x.id === t.dataset.id);
    if (env) {
      const mois = C.currentMonthKey();
      const deja = env.provisionsFaites || [];
      if (!deja.includes(mois)) {
        env.montantAccumule = (env.montantAccumule || 0) + C.provisionMensuelle(env);
        env.provisionsFaites = [...deja, mois];
        await db.put('enveloppes', env);
        await reloadCache(); render();
      }
    }
    return;
  }
  if (action === 'reset-enveloppe') {
    const env = cache.enveloppes.find((x) => x.id === t.dataset.id);
    if (env && confirm(`Démarrer un nouveau cycle pour "${env.nom}" ? Le montant accumulé repart à 0.`)) {
      env.montantAccumule = 0;
      env.provisionsFaites = [];
      await db.put('enveloppes', env);
      await reloadCache(); render();
    }
    return;
  }

  // Épargne
  if (action === 'open-init-matelas') { openSheet(sheetInitMatelas()); return; }
  if (action === 'open-add-projet') { openSheet(sheetAddProjet()); return; }
  if (action === 'open-init-invest') { openSheet(sheetInitInvest()); return; }
  if (action === 'open-mouvement-epargne') { openSheet(sheetMouvementEpargne(t.dataset.id, t.dataset.type)); return; }
  if (action === 'del-epargne') { await db.delete('epargne', t.dataset.id); await reloadCache(); render(); return; }

  // Réglages
  if (action === 'toggle-dark') { toggleDark(); return; }
  if (action === 'reset-simulation') { state.simulation = null; render(); return; }
  if (action === 'replay-onboarding') { state.ob = { step: 0, adultes: 1, ados: 0, enfants: 0, typeRevenus: 'stable', nbProfilsChoice: 'seul', profils: [] }; go('onboarding'); return; }
  if (action === 'export-json') { await exportJSON(); render(); return; }
  if (action === 'dismiss-export-reminder') {
    await db.metaSet('exportReminderDismissedAt', new Date().toISOString());
    cache.exportReminderDismissedAt = new Date().toISOString();
    render(); return;
  }
  if (action === 'open-add-profile') { openSheet(sheetAddProfile()); return; }
  if (action === 'del-profile') {
    if (confirm('Retirer cette personne ? Ses revenus resteront mais ne seront plus rattachés à elle.')) {
      await db.delete('profiles', t.dataset.id);
      await reloadCache(); render();
    }
    return;
  }
  if (action === 'set-repartition-mode') {
    await db.metaSet('repartitionMode', t.dataset.mode);
    cache.repartitionMode = t.dataset.mode;
    render();
    return;
  }
  if (action === 'wipe-data') {
    if (confirm('Toutes tes données seront définitivement supprimées de cet appareil. Continuer ?')) {
      await db.wipeAll();
      location.reload();
    }
    return;
  }

  // Historique
  if (action === 'historique-year') { state.historiqueAnnee += parseInt(t.dataset.delta, 10); render(); return; }
  if (action === 'toggle-metrique') {
    state.historiqueMetriques[t.dataset.metrique] = !state.historiqueMetriques[t.dataset.metrique];
    render(); return;
  }
  if (action === 'print-bilan') { printMonth = t.dataset.mois || C.currentMonthKey(); go('print-bilan'); return; }
  if (action === 'back-from-print') { printMonth = null; go('historique'); return; }
});

app.addEventListener('input', (e) => {
  if (e.target.dataset.obNomIndex !== undefined) {
    state.ob.profils[parseInt(e.target.dataset.obNomIndex, 10)] = e.target.value;
  }
});

app.addEventListener('change', (e) => {
  if (e.target.id === 'charge-type-select') {
    const isCredit = e.target.value === 'credit';
    document.getElementById('charge-normal-fields').style.display = isCredit ? 'none' : '';
    document.getElementById('charge-credit-fields').style.display = isCredit ? '' : 'none';
  }
  if (e.target.id === 'duree-preset-select') {
    document.getElementById('duree-custom-field').style.display = e.target.value === 'custom' ? '' : 'none';
  }
  if (e.target.dataset && e.target.dataset.action === 'import-json') {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm('Importer cette sauvegarde remplacera toutes les données actuelles de Frugi sur cet appareil. Continuer ?')) { e.target.value = ''; return; }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const dump = JSON.parse(reader.result);
        await db.importAll(dump);
        await reloadCache();
        alert('Sauvegarde importée avec succès.');
        go('home');
      } catch (err) {
        alert("Ce fichier ne semble pas être une sauvegarde Frugi valide.");
      }
    };
    reader.readAsText(file);
  }
});

app.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const action = form.dataset.action;
  const fd = new FormData(form);

  if (action === 'submit-revenu') {
    await db.put('revenus', {
      nom: fd.get('nom'), categorie: fd.get('categorie'),
      montant: parseFloat(fd.get('montant')) || 0, recurrence: fd.get('recurrence'),
      profileId: fd.get('profileId') || null,
    });
    await reloadCache(); closeSheet(); go('revenus'); return;
  }

  if (action === 'submit-charge-fixe') {
    const type = fd.get('type');
    if (type === 'credit') {
      const capitalRestant = parseFloat(fd.get('capitalRestant')) || 0;
      await db.put('chargesFixes', {
        nom: fd.get('nom'), type: 'credit',
        capitalRestant, capitalInitial: capitalRestant,
        mensualite: parseFloat(fd.get('mensualite')) || 0,
        tauxAnnuel: parseFloat(fd.get('tauxAnnuel')) || 0,
      });
    } else {
      await db.put('chargesFixes', {
        nom: fd.get('nom'), type: 'normal', categorie: fd.get('categorie'),
        montant: parseFloat(fd.get('montant')) || 0, recurrence: fd.get('recurrence'),
      });
    }
    await reloadCache(); closeSheet(); go('charges'); return;
  }

  if (action === 'submit-categorie-var') {
    await db.put('categoriesVariables', {
      nom: fd.get('nom'), icone: fd.get('icone'),
      budgetPrevisionnel: parseFloat(fd.get('budgetPrevisionnel')) || 0,
    });
    await reloadCache(); closeSheet(); state.chargesTab = 'variables'; go('charges'); return;
  }

  if (action === 'submit-edit-categorie-var') {
    const cat = cache.categoriesVariables.find((c) => c.id === form.dataset.id);
    if (cat) {
      cat.nom = fd.get('nom'); cat.icone = fd.get('icone');
      cat.budgetPrevisionnel = parseFloat(fd.get('budgetPrevisionnel')) || 0;
      await db.put('categoriesVariables', cat);
    }
    await reloadCache(); closeSheet(); state.chargesTab = 'variables'; go('charges'); return;
  }

  if (action === 'submit-quick-add') {
    const tags = (fd.get('tags') || '').split(',').map((t) => t.trim()).filter(Boolean);
    await db.put('depensesVariables', {
      categorieId: form.dataset.categorieId,
      montant: parseFloat(fd.get('montant')) || 0,
      note: fd.get('note') || '',
      tags,
      date: new Date().toISOString(),
    });
    await reloadCache(); closeSheet(); state.chargesTab = 'variables'; go('charges'); return;
  }

  if (action === 'submit-add-enveloppe') {
    const dureePreset = fd.get('dureePreset');
    const dureeMois = dureePreset === 'custom' ? (parseInt(fd.get('dureeCustom'), 10) || 1) : parseInt(dureePreset, 10);
    await db.put('enveloppes', {
      nom: fd.get('nom'), icone: fd.get('icone'),
      montantCible: parseFloat(fd.get('montantCible')) || 0,
      dureeMois,
      montantAccumule: parseFloat(fd.get('montantAccumule')) || 0,
      recurrente: fd.get('recurrente') === 'true',
      provisionsFaites: [],
    });
    await reloadCache(); closeSheet(); go('prevoyance'); return;
  }

  if (action === 'submit-quick-add-enveloppe') {
    const id = form.dataset.id;
    const montant = parseFloat(fd.get('montant')) || 0;
    const env = cache.enveloppes.find((x) => x.id === id);
    if (env) {
      const insuffisant = montant > (env.montantAccumule || 0);
      env.montantAccumule = (env.montantAccumule || 0) - montant;
      await db.put('enveloppes', env);
      await db.put('mouvementsEnveloppe', { enveloppeId: id, montant, note: fd.get('note') || '', date: new Date().toISOString() });
      if (insuffisant) {
        alert(`Attention : cette dépense dépasse ce qu'il restait dans l'enveloppe "${env.nom}". Le solde est maintenant négatif — pense à provisionner davantage ce mois-ci.`);
      }
    }
    await reloadCache(); closeSheet(); go('prevoyance'); return;
  }

  if (action === 'submit-init-matelas') {
    await db.put('epargne', {
      type: 'matelas', nom: 'Matelas de sécurité',
      objectif: parseFloat(fd.get('objectif')) || 0,
      montantAccumule: parseFloat(fd.get('montantAccumule')) || 0,
    });
    await reloadCache(); closeSheet(); go('epargne'); return;
  }

  if (action === 'submit-add-projet') {
    await db.put('epargne', {
      type: 'projet', nom: fd.get('nom'),
      objectif: parseFloat(fd.get('objectif')) || 0,
      montantAccumule: parseFloat(fd.get('montantAccumule')) || 0,
      compteAssocie: fd.get('compteAssocie') || '',
    });
    await reloadCache(); closeSheet(); go('epargne'); return;
  }

  if (action === 'submit-init-invest') {
    let invest = cache.epargne.find((x) => x.type === 'investissement');
    await db.put('epargne', {
      id: invest ? invest.id : undefined,
      type: 'investissement', nom: 'Investissement',
      montantAccumule: parseFloat(fd.get('montantAccumule')) || 0,
      objectif: 0,
    });
    await reloadCache(); closeSheet(); go('epargne'); return;
  }

  if (action === 'submit-mouvement-epargne') {
    const id = form.dataset.id;
    const type = form.dataset.type;
    const montant = parseFloat(fd.get('montant')) || 0;
    const item = cache.epargne.find((x) => x.id === id);
    if (item) {
      item.montantAccumule = type === 'depot' ? item.montantAccumule + montant : Math.max(0, item.montantAccumule - montant);
      await db.put('epargne', item);
      await db.put('mouvementsEpargne', { epargneId: id, montant, type, date: new Date().toISOString() });
    }
    await reloadCache(); closeSheet(); go('epargne'); return;
  }

  if (action === 'submit-add-profile') {
    await db.put('profiles', { nom: fd.get('nom') });
    await reloadCache(); closeSheet(); go('settings'); return;
  }

  if (action === 'submit-simulation') {
    state.simulation = {
      revenus: parseFloat(fd.get('revenus')) || 0,
      chargesFixes: parseFloat(fd.get('chargesFixes')) || 0,
      depensesVar: parseFloat(fd.get('depensesVar')) || 0,
      provisions: parseFloat(fd.get('provisions')) || 0,
    };
    render(); return;
  }

  if (action === 'submit-repartir-ligne') {
    const id = form.dataset.id;
    const c = cache.chargesFixes.find((x) => x.id === id);
    if (c) {
      const rep = {};
      let total = 0;
      cache.profiles.forEach((p) => {
        const v = parseFloat(fd.get(`pct_${p.id}`)) || 0;
        rep[p.id] = v;
        total += v;
      });
      if (Math.abs(total - 100) > 0.5) {
        alert(`Le total fait ${Math.round(total)}% — il doit faire 100%. Ajuste les valeurs avant d'enregistrer.`);
        return;
      }
      c.repartitionLibre = rep;
      await db.put('chargesFixes', c);
    }
    await reloadCache(); closeSheet(); go('charges'); return;
  }
});

// ===================== SIMULATION ("Et si...") =====================
function ensureSimulationInit() {
  if (state.simulation) return;
  const mois = C.currentMonthKey();
  state.simulation = {
    revenus: Math.round(C.sumRevenusMensuels(cache.revenus)),
    chargesFixes: Math.round(C.sumChargesFixesMensuelles(cache.chargesFixes)),
    depensesVar: Math.round(C.sumDepensesVariablesDuMois(cache.depensesVariables, mois)),
    provisions: Math.round(C.sumProvisionsEnveloppes(cache.enveloppes)),
  };
}

function renderSimulation() {
  ensureSimulationInit();
  const s = state.simulation;
  const mois = C.currentMonthKey();
  const resteActuel = C.sumRevenusMensuels(cache.revenus) - C.sumChargesFixesMensuelles(cache.chargesFixes)
    - C.sumDepensesVariablesDuMois(cache.depensesVariables, mois) - C.sumProvisionsEnveloppes(cache.enveloppes);
  const resteSimule = s.revenus - s.chargesFixes - s.depensesVar - s.provisions;
  const diff = resteSimule - resteActuel;

  return `
    ${topbar("Et si...")}
    <div class="screen" style="padding-top:6px;">
      <div class="card">
        <p style="font-size:12.5px; color:var(--text-soft); margin-bottom:14px;">
          Teste l'effet d'un changement (nouveau loyer, perte de revenu, dépense en plus...) sans rien modifier dans tes vraies données.
        </p>
        <form data-action="submit-simulation">
          <div class="field">
            <label>Revenus mensuels</label>
            <input name="revenus" type="number" step="1" value="${s.revenus}" inputmode="decimal" />
          </div>
          <div class="field">
            <label>Charges fixes</label>
            <input name="chargesFixes" type="number" step="1" value="${s.chargesFixes}" inputmode="decimal" />
          </div>
          <div class="field">
            <label>Dépenses courantes (mensuel estimé)</label>
            <input name="depensesVar" type="number" step="1" value="${s.depensesVar}" inputmode="decimal" />
          </div>
          <div class="field">
            <label>Provisions prévoyance</label>
            <input name="provisions" type="number" step="1" value="${s.provisions}" inputmode="decimal" />
          </div>
          <button class="btn btn-primary btn-block" type="submit">Recalculer</button>
        </form>
        <button class="btn btn-ghost btn-block" style="margin-top:8px;" data-action="reset-simulation">Réinitialiser avec mes vraies données</button>
      </div>

      <div class="card" style="text-align:center;">
        <div class="gauge-label">Reste à vivre simulé</div>
        <div class="gauge-value" style="color:${resteSimule < 0 ? 'var(--alerte-dark)' : 'inherit'};">${C.formatEUR(resteSimule)}</div>
        <p style="font-size:12.5px; color:var(--text-soft); margin-top:8px;">
          contre ${C.formatEUR(resteActuel)} actuellement
          (${diff === 0 ? 'aucun changement' : diff > 0 ? `+${C.formatEUR(diff)}` : C.formatEUR(diff)})
        </p>
      </div>
    </div>`;
}

function toggleDark() {
  document.body.classList.toggle('dark');
  db.metaSet('darkMode', document.body.classList.contains('dark'));
}

async function exportJSON() {
  const dump = await db.exportAll();
  const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `frugi-sauvegarde-${C.currentMonthKey()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  await db.metaSet('lastExportDate', new Date().toISOString());
  cache.lastExportDate = new Date().toISOString();
}

// ===================== INIT =====================
boot();


})();
