# DreamBuild

DreamBuild is a responsive construction-company website with home, services, and contact pages.

## Features

- Responsive navigation and layouts for desktop and mobile screens.
- AI-generated About Us and services content on the homepage.
- Gemini-powered project assistant chatbot on the homepage, routed through a server so the API key is not exposed in browser code.
- Contact form that remembers a visitor's name and email in browser local storage and shows an on-page success message.

The contact form currently demonstrates front-end behavior only; it does not send submissions to a server.

## Run locally with the chatbot

1. Install Node.js 18 or newer.
2. Create a new Gemini API key. Do not reuse a key that has been exposed or committed.
3. In PowerShell, create a `.env` file in the `project` folder with `GEMINI_API_KEY=YOUR_GEMINI_API_KEY`, then start the server from that folder. `.env` is ignored by Git. Alternatively, set the key in PowerShell before starting the server:

   ```powershell
   $env:GEMINI_API_KEY = "YOUR_NEW_GEMINI_API_KEY"
   node server.js
   ```

4. Open `http://127.0.0.1:3000` in a browser. The chatbot and generated homepage content need the `/api/generate` endpoint. If you prefer VS Code Live Server, keep `node server.js` running in a terminal and use Live Server's default port `5500`; the page will connect to the local API automatically. Opening the HTML directly or using another static server will not provide the API.

The server uses `gemini-3.8-flash` by default. Set `GEMINI_MODEL` in the server environment to use a different model available to your Gemini API key. Keep the key in the server environment (or a deployment secret manager), never in HTML or JavaScript. GitHub Pages cannot run this Node server; deploy the site and API endpoint to a host that supports server-side Node.js. For public deployments, also configure host-level rate limiting and set `HOST=0.0.0.0` if required by the hosting provider.

No npm packages or build step are required.
