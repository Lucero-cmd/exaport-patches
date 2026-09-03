# exaport-patches

This is a patched fork of **Exabis ePortfolio** (`block_exaport`) for Moodle, maintained for
Alex D&D Training's own site. It tracks the upstream plugin plus a set of local customizations
that are **not** part of the official Exabis release and would be lost if the official plugin
update is ever installed over this code (see [Deployment notes](#deployment-notes) below).

## What's different from upstream

- **Company manager role support** — the `companymanager` role can see its own company's
  teachers throughout the plugin (`lib/lib.php`), a local customization not present upstream.
- **Inline PDF viewer** — PDF item files render inline with page navigation and zoom instead of
  forcing a download (`lib/lib.php`, `lib/externlib.php`, `css/pdf_annotate.css`,
  `javascript/pdfviewer/pdf_annotate.js`). Uses [pdf.js](https://mozilla.github.io/pdf.js/),
  loaded from a CDN and run in an isolated execution scope to avoid colliding with Moodle's own
  RequireJS (see the comment above the asset-loading code in `lib/lib.php` for why).
- **PDF markup/annotation tools** — comment pins, drag-drawn highlight boxes, and freehand pen
  strokes can be added directly on top of a PDF page, with a colour picker, zoom, drag-to-move,
  and resize (highlights). Backed by a new DB table (`block_exaport_pdfannot`), a new AJAX
  endpoint (`ajax_pdf_annotations.php`), and a new capability (`block/exaport:annotatepdf`,
  granted by default to teacher/editingteacher/manager — **not** `companymanager`, which needs
  manual capability assignment if that role should be able to mark up PDFs too).

See `CHANGES.md` for the detailed, dated changelog of each patch.

## Deployment notes

- Staging deploys via `git pull` directly into `blocks/exaport` on the server (not a manual
  file copy) — see the repo's commit history for the exact sequence this was set up with.
- After any `git pull` that touches the DB schema (new tables/fields), run Moodle's upgrade
  step: `php <moodle-root>/admin/cli/upgrade.php --non-interactive`, then
  `php <moodle-root>/admin/cli/purge_caches.php`.
- **Do not install the official Exabis ePortfolio update from Site administration → Plugins**
  on any site running this fork — the official release does not include the customizations
  above, and installing it will silently overwrite this code. If Moodle shows an update is
  available, that means there's a new upstream release worth reviewing and merging in
  deliberately (diff it against the current upstream, reconcile with the local changes, test on
  staging), not something to install directly through the notifications page.
- Some files on the live staging server were, for a period, locked read-only
  (`chmod 444`) as a precaution after files were repeatedly and unexplainedly reverted to an
  older version. If those files are still locked when you go to deploy an update, run
  `chmod 644` on them first, `git pull`, then decide whether to re-lock.

## Original plugin documentation (upstream)

The rest of this README is Exabis's own documentation for the base plugin, kept for reference.


exaport is a free Moodle plugin designed to build up ePortfolios with an individual structure. Students can create, collect and share outcomes of their learning process in the form of a digital portfolio.
This module enables the following functionality:

- linking ePortfolio-artefacts to competences
- publishing of views with a selection of material
- export to Europass for CVs
- integration of OpenBadges
- export to SCORM-format

This block can easily be added to a Moodle installation. It works course-independently.

#INSTALLATION:
This block is for Moodle 3.11 to 4.3 versions, it will not work for versions below 2021051700 - please download earlier
versions from here: https://moodle.org/plugins/pluginversions.php?plugin=block_exaport

Download the plugin from Moodle Plug-ins Repository. Please follow the instructions available in the Moodle Plug-ins Repository.

Download directly from Github:

Save the zip file somewhere onto your local computer and extract all the files
Transfer the folder “exaport” to the blocks-directory of Moodle
Login as admin and start the installation procedure
Installation is done, trainers may use the block in their courses.

For more information on setting up the plug-in please refer to the documentation.

# USAGE:

ePortfolios can be built up individually or collaboratively
Under the first tab, My CV, the user will find his/her informational page. This can also be seen as a basic introductory page for the personal CV.
Materials, so-called artifacts, can be collected and published selectively using views
Portfolio users can directly upload their own data via file-upload, add links to other external websites (i.e. social media resources such as YouTube etc.) or add some notes in their portfolios. Artifacts can be added within categories, new
categories can be created.
Learning products can be linked to competences (see Exabis Competence Grids)
The Exabis ePortfolio module can be associated with the module Exabis Competence Grid, used for adaptive learning scenarios and enables competence association with portfolios. Competencies can be added by clicking "choose competences
associated with your upload”.

Export to Europass for CVs
This is done via the tab “Export to Europass”  (for more information related to the Europass, please visit www.europass.eu).

Export to SCORM-format
For this a view has to be selected, then the export can be done. The file can be adjusted offline with every SCORM-Editor. With the same function, certain SCORM-packages can be imported as well.
For more information, refer to the documentation.

# LICENCE:

Exabis E-Portfolio is a free software: you can redistribute it and/or modify it. It is published under the terms of the GNU General Public License (Free Software Foundation), either version 3 of the License, or any later version.
This script is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.

# DISCLAIMER

As with any customization, it is recommended that you have a good backup of your Moodle site before attempting to install
contributed code.
While those contributing code make every effort to provide the best code that they can, using contributed code nevertheless
entails a certain degree of risk as contributed code is not as carefully reviewed and/or tested as the Moodle core code.
Hence, use this block at your own risk.

# HISTORY

In August 2011 exabis ePortfolio was associated with Exabis Competence Grid Block. This enables ePortfolio-users to categorize
their artefacts with educational standards. These standards are linked to Moodle via the exabis-competencies Block with an associated XML-file.
In April 2011, gtn gmbh (https://gtn-solutions.com) updated exabis ePortfolio to be compatible with Moodle 2.0-versions.
This was done with kind support of Gerente de Sistemas y Tecnologías, UNIVERSIDAD TECNOLÓGICA DE CHILE – INACAP.
In version 3.2.4 views were introduced.
Originally exabis ePortfolio was developed in the year 2007 with kind support of the Federal Ministry of Education in Austria.
It was then certified as the first Moodle-Block that was reviewed by the Moodle-core team (Peter Skoda).

# AUTHOR

2016 GTN - Global Training Network GmbH <office@gtn-solutions.com>
