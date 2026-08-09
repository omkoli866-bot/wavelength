# Wavelength — random 1-on-1 anonymous chat

A minimal Omegle-style text chat: pick your gender, pick who you want to talk
to (anyone / male / female), and get paired with a random stranger.
Built with Node.js, Express, and Socket.io.

## Run it locally

```bash
npm install
npm start
```

Then open `http://localhost:3000` in two different browser tabs (or two
devices) to simulate two strangers meeting.

## How matching works

- `server.js` keeps a waiting list of `{ socketId, gender, prefer }`.
- When someone clicks "Start chatting," the server looks for a waiting user
  whose preference is compatible in both directions, and pairs them into a
  private 1-on-1 room.
- "Skip" drops the current chat and immediately re-queues you.
- Messages only ever pass through the server between two matched sockets —
  nothing is stored to disk.

## Deploying so real strangers can use it

Any Node host works (Render, Railway, Fly.io, a VPS, etc.). Key things to
change before opening this to the public:

1. **HTTPS** — put it behind a reverse proxy (Caddy/Nginx) or a host that
   terminates TLS for you. Socket.io needs WSS in production.
2. **Age verification** — the current checkbox is an honor-system checkbox,
   not real age verification. If minors could plausibly access this, you
   need a stronger gate and to consult a lawyer about what's required in
   your jurisdiction — anonymous chat products that pair adults and minors
   carry serious legal and safety risk.
3. **Moderation** — `blockedWords` in `server.js` is a placeholder, not a
   moderation system. For anything public you'll want: a real profanity/
   image filter, rate limiting per IP, a way to actually act on "report"
   events (the current handler just logs to the console), and probably a
   ban list keyed on IP or a persistent device id.
4. **Abuse/rate limiting** — add something like `express-rate-limit` and a
   per-socket message-rate cap so one person can't spam-flood a partner.
5. **Terms of service / privacy policy** — required in most jurisdictions
   once you're handling other people's conversations, even if you don't
   store them.
6. **Scaling** — this uses in-memory matching state, so it only works on a
   single server process. For multiple instances you'd need to move the
   waiting-queue/pairing state into Redis (Socket.io has an official Redis
   adapter for this).

## File structure

```
random-chat/
├── server.js            # Express + Socket.io backend, matching logic
├── package.json
└── public/
    ├── index.html        # Landing page (hero, how it works, safety)
    ├── chat.html          # The actual app: setup → waiting → chat screens
    ├── guidelines.html     # Community guidelines
    ├── privacy.html         # Privacy policy
    ├── styles.css            # Shared design system for every page
    └── favicon.svg
```

`/chat` also works as a shortcut to `chat.html` (see `server.js`).
