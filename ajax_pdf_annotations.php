<?php
// This file is part of Exabis Eportfolio (extension for Moodle)
//
// Moodle is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// Moodle is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with Moodle.  If not, see <http://www.gnu.org/licenses/>.
//
// AJAX endpoint backing the inline PDF viewer's annotation layer (pins/highlights).
// Access to the underlying item is authorised the same way portfoliofile.php and
// shared_item.php already do it: via the "access" token resolved through
// block_exaport_get_item(). Writing (save/delete/resolve) additionally requires the
// block/exaport:annotatepdf capability, checked inside pdf_annotation_manager.

require_once(__DIR__ . '/inc.php');
require_once(__DIR__ . '/classes/pdf_annotation_manager.php');

require_login(0, false);

// NO_MOODLE_COOKIES not set - this endpoint relies on a normal logged-in session, same
// as shared_item.php, so it works for tokenless (session-based) access to shared items.

$itemid = required_param('itemid', PARAM_INT);
$access = required_param('access', PARAM_TEXT);
$filehash = required_param('inst', PARAM_ALPHANUM);
$action = optional_param('action', 'list', PARAM_ALPHA);

header('Content-Type: application/json; charset=utf-8');

try {
    $item = block_exaport_get_item($itemid, $access);
    if (!$item) {
        throw new \moodle_exception('bookmarknotfound', 'block_exaport');
    }

    $manager = new \block_exaport\pdf_annotation_manager($item, $filehash);

    switch ($action) {
        case 'list':
            echo json_encode([
                'success' => true,
                'annotations' => $manager->get_annotations(),
                'canannotate' => $manager->can_annotate(),
            ]);
            break;

        case 'save':
            require_sesskey();
            $annotation = $manager->save_annotation([
                'page' => required_param('page', PARAM_INT),
                'x' => optional_param('x', 0, PARAM_FLOAT),
                'y' => optional_param('y', 0, PARAM_FLOAT),
                'width' => optional_param('width', null, PARAM_FLOAT),
                'height' => optional_param('height', null, PARAM_FLOAT),
                'type' => optional_param('type', 'comment', PARAM_ALPHA),
                'colour' => optional_param('colour', '#ffe066', PARAM_TEXT),
                'content' => optional_param('content', '', PARAM_TEXT),
                'pathdata' => optional_param('pathdata', null, PARAM_RAW),
            ]);
            echo json_encode(['success' => true, 'annotation' => $annotation]);
            break;

        case 'update':
            require_sesskey();
            $update = [];
            foreach (['x', 'y', 'width', 'height'] as $key) {
                $val = optional_param($key, null, PARAM_FLOAT);
                if ($val !== null) {
                    $update[$key] = $val;
                }
            }
            $pathdata = optional_param('pathdata', null, PARAM_RAW);
            if ($pathdata !== null) {
                $update['pathdata'] = $pathdata;
            }
            $annotation = $manager->update_annotation(required_param('id', PARAM_INT), $update);
            echo json_encode(['success' => true, 'annotation' => $annotation]);
            break;

        case 'delete':
            require_sesskey();
            $manager->delete_annotation(required_param('id', PARAM_INT));
            echo json_encode(['success' => true]);
            break;

        case 'resolve':
            require_sesskey();
            $manager->set_resolved(required_param('id', PARAM_INT), (bool)optional_param('resolved', 1, PARAM_INT));
            echo json_encode(['success' => true]);
            break;

        default:
            throw new \moodle_exception('unknownaction', 'block_exaport');
    }
} catch (\Throwable $e) {
    http_response_code(400);
    echo json_encode(['success' => false, 'error' => $e->getMessage()]);
}
