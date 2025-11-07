const express = require("express")
const router = express.Router()
const crypto = require("crypto")

// In-memory user storage (replace with database in production)
const users = new Map()
const sessions = new Map()

// GitHub OAuth Configuration
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || "your_github_client_id"
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || "your_github_client_secret"
const GITHUB_REDIRECT_URI = process.env.GITHUB_REDIRECT_URI || "http://localhost:8000/auth/github/callback"

// Helper functions
function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex")
}

function generateSessionToken() {
  return crypto.randomBytes(32).toString("hex")
}

// Login route
router.post("/login", (req, res) => {
  const { email, password } = req.body

  if (!email || !password) {
    return res.status(400).json({ message: "Email and password are required" })
  }

  const user = Array.from(users.values()).find((u) => u.email === email)

  if (!user || user.password !== hashPassword(password)) {
    return res.status(401).json({ message: "Invalid email or password" })
  }

  const token = generateSessionToken()
  sessions.set(token, { userId: user.id, email: user.email, createdAt: Date.now() })

  res.cookie("sessionToken", token, {
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  })

  res.json({
    message: "Login successful",
    user: { id: user.id, email: user.email, name: user.name },
  })
})

// Register route
router.post("/register", (req, res) => {
  const { name, email, password } = req.body

  if (!name || !email || !password) {
    return res.status(400).json({ message: "All fields are required" })
  }

  if (Array.from(users.values()).some((u) => u.email === email)) {
    return res.status(409).json({ message: "Email already registered" })
  }

  const userId = crypto.randomUUID()
  const user = {
    id: userId,
    name,
    email,
    password: hashPassword(password),
    createdAt: Date.now(),
  }

  users.set(userId, user)

  res.status(201).json({
    message: "Account created successfully",
    user: { id: user.id, email: user.email, name: user.name },
  })
})

// GitHub OAuth - Initiate login
router.get("/github", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex")
  sessions.set(`github_state_${state}`, { createdAt: Date.now() })

  const githubAuthUrl = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&redirect_uri=${encodeURIComponent(GITHUB_REDIRECT_URI)}&scope=user:email&state=${state}`

  res.redirect(githubAuthUrl)
})

// GitHub OAuth - Callback
router.get("/github/callback", async (req, res) => {
  const { code, state } = req.query

  if (!code || !state) {
    return res.redirect("/login?error=invalid_request")
  }

  // Verify state
  if (!sessions.has(`github_state_${state}`)) {
    return res.redirect("/login?error=invalid_state")
  }

  try {
    // Exchange code for access token
    const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/vnd.github.v3+json",
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: GITHUB_REDIRECT_URI,
      }),
    })

    const tokenData = await tokenResponse.json()

    if (!tokenData.access_token) {
      return res.redirect("/login?error=token_exchange_failed")
    }

    // Get user info from GitHub
    const userResponse = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: "application/vnd.github.v3+json",
      },
    })

    const githubUser = await userResponse.json()

    // Get user email
    const emailResponse = await fetch("https://api.github.com/user/emails", {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: "application/vnd.github.v3+json",
      },
    })

    const emails = await emailResponse.json()
    const primaryEmail = emails.find((e) => e.primary)?.email || emails[0]?.email

    // Check if user exists
    let user = Array.from(users.values()).find((u) => u.githubId === githubUser.id)

    if (!user) {
      // Create new user
      const userId = crypto.randomUUID()
      user = {
        id: userId,
        name: githubUser.name || githubUser.login,
        email: primaryEmail,
        githubId: githubUser.id,
        githubLogin: githubUser.login,
        avatar: githubUser.avatar_url,
        createdAt: Date.now(),
      }
      users.set(userId, user)
    }

    // Create session
    const sessionToken = generateSessionToken()
    sessions.set(sessionToken, { userId: user.id, email: user.email, createdAt: Date.now() })

    res.cookie("sessionToken", sessionToken, {
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    })

    // Clean up state
    sessions.delete(`github_state_${state}`)

    res.redirect("/dashboard")
  } catch (error) {
    console.error("GitHub OAuth error:", error)
    res.redirect("/login?error=authentication_failed")
  }
})

// Logout route
router.post("/logout", (req, res) => {
  res.clearCookie("sessionToken")
  res.json({ message: "Logged out successfully" })
})

// Get current user
router.get("/me", (req, res) => {
  const sessionToken = req.cookies.sessionToken

  if (!sessionToken || !sessions.has(sessionToken)) {
    return res.status(401).json({ message: "Not authenticated" })
  }

  const session = sessions.get(sessionToken)
  const user = users.get(session.userId)

  res.json({ user: { id: user.id, email: user.email, name: user.name } })
})

module.exports = router
