// papyrates-auth.js — include on every protected page
// Usage: <script src="/papyrates-auth.js"></script>
// Then call: requireAuth('readonly') or requireAuth('research') or requireAuth('admin')

const PAPYRATES_SESSION_KEY = 'papyrates_session';
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

function getPapyratesSession() {
  try {
    const raw = localStorage.getItem(PAPYRATES_SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    if (!session.tier || !session.expires) return null;
    if (Date.now() > session.expires) {
      localStorage.removeItem(PAPYRATES_SESSION_KEY);
      return null;
    }
    return session;
  } catch (e) {
    return null;
  }
}

function getPapyratesTier() {
  const session = getPapyratesSession();
  return session ? session.tier : null;
}

function setPapyratesSession(tier) {
  const session = {
    tier: tier,
    expires: Date.now() + SESSION_DURATION_MS
  };
  localStorage.setItem(PAPYRATES_SESSION_KEY, JSON.stringify(session));
}

function clearPapyratesSession() {
  localStorage.removeItem(PAPYRATES_SESSION_KEY);
}

// Tier hierarchy: admin > research > readonly
const TIER_LEVEL = { readonly: 1, research: 2, admin: 3 };

function hasTierAccess(userTier, requiredTier) {
  return (TIER_LEVEL[userTier] || 0) >= (TIER_LEVEL[requiredTier] || 99);
}

// Call this at the top of every protected page
// requiredTier: 'readonly', 'research', or 'admin'
function requireAuth(requiredTier) {
  const session = getPapyratesSession();
  if (!session || !hasTierAccess(session.tier, requiredTier)) {
    window.location.href = '/index.html';
    return null;
  }
  return session.tier;
}
