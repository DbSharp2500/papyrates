export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ error: "No password provided" });
  }

  if (password === process.env.PASSWORD_ADMIN) {
    return res.status(200).json({ tier: "admin" });
  }

  if (password === process.env.PASSWORD_RESEARCH) {
    return res.status(200).json({ tier: "research" });
  }

  if (password === process.env.PASSWORD_READONLY) {
    return res.status(200).json({ tier: "readonly" });
  }

  return res.status(401).json({ error: "Incorrect password" });
}
