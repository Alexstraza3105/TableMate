# Tablemate + Notion (secure first deployment)

This bundle uses Cloudflare Pages Functions so the Notion integration token stays on the server. The browser only calls `/api/recipes`; the token is never placed in HTML/JavaScript.

## Before deploying
1. Confirm the `Tablemate` Notion integration has **Read content** only.
2. In Notion, share the actual recipe database with `Tablemate` as well as the containing Recipes page if the database is nested.
3. The shared Recipes page ID from the link provided is `51df6132-db61-46c5-a5f7-ea462b2bb863`.

## Deploy on Cloudflare Pages
1. Create a new **private** GitHub repository (recommended) and upload the contents of this folder, preserving `public/` and `functions/`.
2. In Cloudflare Dashboard, go to **Workers & Pages → Create → Pages → Connect to Git** and select that repository.
3. Build settings: framework preset **None**, build command leave blank, build output directory `public`.
4. After deployment, open the Pages project → **Settings → Variables and Secrets** (or **Environment variables**, depending on UI).
5. Add secrets/variables for both Production (and Preview only if needed):
   - `NOTION_TOKEN` = the internal integration token. Mark it **Secret**. Never commit it to Git.
   - `NOTION_PAGE_ID` = `51df6132-db61-46c5-a5f7-ea462b2bb863`
6. Redeploy after setting variables.
7. Open the site, go to **Setup & data**, then press **Import recipes from Notion**.

## Important notes
- The first import is one-way: Notion recipes are copied into Tablemate's local browser storage. Editing them in Tablemate does not edit Notion.
- The current importer looks for databases nested below the shared Recipes page, including child pages, and maps common property names (name/title, ingredients, instructions/method, category/meal type, cooking time, servings, cost, URL). If your Notion database uses unusual property names or stores recipe ingredients only as page body blocks, those may need a mapping adjustment.
- Tablemate's planner data currently lives in localStorage on that browser/device. This is not household cross-device sync yet.
- Do not paste the Notion token into ChatGPT, a public issue, or the website settings. If a token is exposed, rotate it in Notion.

## Local test
A static HTML file opened directly with `file://` cannot use this server function. Deploy to Cloudflare Pages, or run the Pages dev server with Wrangler after installing Node.js and Wrangler.
