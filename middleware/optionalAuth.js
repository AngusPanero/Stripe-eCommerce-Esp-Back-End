const SESSION_COOKIES = (process.env.SESSION_COOKIE_NAMES || "token")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const leerCookie = (req, nombre) => {
  if (req.cookies && req.cookies[nombre]) return req.cookies[nombre];   // con cookie-parser
  const raw = req.headers.cookie || "";                                  // sin cookie-parser
  const par = raw.split(";").map(c => c.trim()).find(c => c.startsWith(`${nombre}=`));
  return par ? decodeURIComponent(par.slice(nombre.length + 1)) : null;
};

const traeCredenciales = (req) => {
  const auth = req.headers.authorization || "";
  if (/^Bearer\s+\S+/i.test(auth)) return true;
  return SESSION_COOKIES.some(nombre => !!leerCookie(req, nombre));
};

export const optionalAuth = (authMiddleware) => (req, res, next) => {
  if (!traeCredenciales(req)) {
    req.user    = undefined;
    req.isGuest = true;
    return next();
  }
  req.isGuest = false;
  return authMiddleware(req, res, next);
};

export default optionalAuth;