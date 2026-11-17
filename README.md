# Bohol ASF Watch

A lightweight, browser-based African swine fever (ASF) surveillance dashboard for Bohol's 47 municipalities and their 1,094 barangays. It runs without a build step or external JavaScript dependencies.

The bundled barangay names and PSGC codes are from the [PSGC API](https://psgc.gitlab.io/api/) for province code `071200000`, retrieved November 1, 2026. This API distributes PSGC data; verify the current directory with the Philippine Statistics Authority before operational use. The 47-municipality list excludes Tagbilaran City, which is a separate local government unit.

The pig background photo is [Pig farm Vampula 9](https://commons.wikimedia.org/wiki/File:Pig_farm_Vampula_9.jpg) by Kallerna, licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

The header uses the Province of Bohol's official seal, credited to the Provincial Government of Bohol via [bohol.ph](https://commons.wikimedia.org/wiki/File:Bohol_Province_Seal.png) and marked public domain.

## Run the local browser version

Open `index.html` in a modern browser. Reports are saved in that browser's local storage. This mode is for a single browser and does not provide sign-in or shared data.

## Run the PHP shared-server version

Requires PHP 8.1+ with PDO SQLite enabled. Configure a production web server to use `index.php` as its directory index, enable HTTPS, and keep the SQLite data directory writable only by the PHP service account. By default, the database is stored in a `bohol-asf-data` directory beside (not inside) the web root. Set `ASF_DB_PATH` to choose another protected database path. Do not expose the database file or place it in a public directory.

For a local Windows PHP installation where the SQLite extension is present but not enabled, open PowerShell in this folder and start the PHP server with:

```powershell
php -d extension_dir="C:\php\ext" -d extension=php_pdo_sqlite.dll -S localhost:8000
```

For standard PHP installations with PDO SQLite already enabled, use `php -S localhost:8000`. Open `http://localhost:8000/`; the PHP front controller redirects signed-out visitors to the login page. Create the first admin from another terminal:

```powershell
php -d extension_dir="C:\php\ext" -d extension=php_pdo_sqlite.dll create-user.php admin admin
```

The command prompts for a masked password and confirmation on Windows. The first account must have the `admin` role. Once signed in, administrators can create Admin, Editor, and Viewer accounts and change roles from the separate Admin page's Accounts section. Editors can manage reports; Viewers are read-only. The first database starts empty; restore an existing JSON backup from the Admin page when ready. All signed-in users access the same server data. Keep HTTPS enabled on deployed servers; `localhost` is suitable only for local testing.

## Use

- Expand a municipality to see its barangays and latest reported status. Record each update against a specific barangay.
- Search by municipality or barangay and filter by the latest barangay status.
- Narrow the coverage list by municipality, report-date range, and status; reports 30 or more days old are flagged for an update.
- Review monthly report trends and an interactive municipality boundary map. Boundary data is from [geoBoundaries gbOpen PHL ADM3](https://github.com/wmgeolab/geoBoundaries/tree/9469f09/releaseData/gbOpen/PHL/ADM3), sourced from NAMRIA, PSA and OCHA Philippines (2020), CC BY 3.0 IGO. Boundaries are for orientation and reports shown are locally entered, not verified cases.
- Edit or delete recent report entries. Additions, edits, deletes and backup restores are listed in the change log (last 1,000 events).
- Use the separate Admin page to review report/history counts and access backup, restore, export, user-account, and change-history tools. The browser-only version has no login; the PHP `admin.php` page requires an Admin account.
- Use **Load demo data** on the separate Admin page to preview fictional reports, status summaries, trends, and map colors in place. The dashboard shows a prominent warning while sample records are present. Loading replaces reports and history currently stored in the browser or shared server database; download a backup first if needed. The sample data is not real ASF surveillance.
- A duplicate report for the same barangay and date requires confirmation. Future report dates and unusual counts also prompt a data-quality review.
- Print a dashboard summary or export report rows matching the current search, status, municipality and date filters.
- On the Admin page, download a JSON backup including reports and change history or restore it (up to 5 MB). Restoring replaces the reports and history in the selected browser or shared server database.
- The browser-only version stores records locally. PHP mode stores shared records in SQLite and requires the PHP server to be available; authenticated PHP pages and API requests are not cached for offline use.
- A barangay report is considered recent for the coverage metric when its report date is within the last 7 days.
- The trend chart counts submitted reports by report date and status; it is not a count of active cases.

## Important limitations

The static browser-only mode is not a shared multi-user or real-time system. Its separate `admin.html` page manages local browser data only and has no authentication. In PHP mode, use the separate `admin.php` page; only Admin accounts can access it. PHP mode adds local-server authentication and shared SQLite storage, but it does not add a managed hosting service, automatic off-site backups, an official case data feed, or a connection to a veterinary reporting system. Protect deployed systems with HTTPS, OS/server access controls, and a tested backup process. The dashboard intentionally distinguishes barangays with no entered report from those with a submitted “No suspected cases reported” status. Confirm the directory, reports, and response decisions with the appropriate veterinary authorities.

Do not enter personal or sensitive information. For province-wide operational deployment, use an approved, access-controlled server and coordinate data definitions, validation, retention, and reporting workflows with the Provincial Veterinary Office.
