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

namespace block_exaport;

defined('MOODLE_INTERNAL') || die();

/**
 * Handles reading/writing PDF pin & highlight annotations for a single item file.
 *
 * Access to the underlying item must already have been resolved and authorised by the
 * caller via block_exaport_get_item($itemid, $access) - this class does not re-check
 * whether the current user is allowed to *see* the item, only whether they may *write*
 * annotations to it.
 */
class pdf_annotation_manager {

    /** @var \stdClass the exaport item (as returned by block_exaport_get_item) */
    protected $item;

    /** @var string pathnamehash of the stored_file being annotated */
    protected $filehash;

    /**
     * @param \stdClass $item item record with at least ->id
     * @param string $filehash pathnamehash of the file being annotated
     */
    public function __construct($item, $filehash) {
        $this->item = $item;
        $this->filehash = clean_param($filehash, PARAM_ALPHANUM);
    }

    /**
     * Can the current user create/mark up annotations on this item's PDF?
     *
     * @return bool
     */
    public function can_annotate(): bool {
        return has_capability('block/exaport:annotatepdf', \context_system::instance());
    }

    /**
     * Can the current user manage (delete/resolve) any annotation, not just their own?
     *
     * @return bool
     */
    protected function can_manage_all(): bool {
        return has_capability('block/exaport:annotatepdf', \context_system::instance());
    }

    /**
     * Return all annotations for this item/file, oldest first.
     *
     * @return array
     */
    public function get_annotations(): array {
        global $DB;

        $records = $DB->get_records('block_exaport_pdfannot',
            ['itemid' => $this->item->id, 'filehash' => $this->filehash], 'timecreated ASC');

        $out = [];
        foreach ($records as $record) {
            $out[] = $this->export_one($record);
        }
        return $out;
    }

    /**
     * Create a new annotation.
     *
     * @param array $data page, x, y, width, height, type, colour, content, pathdata (pen only)
     * @return array exported annotation
     */
    public function save_annotation(array $data): array {
        global $DB, $USER;

        if (!$this->can_annotate()) {
            throw new \moodle_exception('nopermissions', 'error', '', get_string('exaport:annotatepdf', 'block_exaport'));
        }

        $type = $data['type'] ?? 'comment';
        if (!in_array($type, ['comment', 'highlight', 'pen'], true)) {
            $type = 'comment';
        }

        $content = trim((string)($data['content'] ?? ''));
        if ($type === 'comment' && $content === '') {
            // A pin's whole purpose is the note attached to it; highlight/pen marks can
            // stand alone (e.g. just circling something) so content is optional for those.
            throw new \invalid_parameter_exception('content is required for a comment pin');
        }

        $record = new \stdClass();
        $record->itemid = $this->item->id;
        $record->filehash = $this->filehash;
        $record->userid = $USER->id;
        $record->page = max(1, (int)($data['page'] ?? 1));
        $record->annotype = $type;
        $record->colour = $this->clean_colour($data['colour'] ?? '#ffe066');
        $record->content = $content;
        $record->resolved = 0;
        $record->timecreated = time();
        $record->timemodified = $record->timecreated;

        if ($type === 'pen') {
            $points = $this->clean_pathdata($data['pathdata'] ?? null);
            $bbox = $this->bounding_box($points);
            $record->xpos = $bbox['x'];
            $record->ypos = $bbox['y'];
            $record->width = $bbox['width'];
            $record->height = $bbox['height'];
            $record->pathdata = json_encode($points);
        } else {
            $record->xpos = $this->clamp_percent($data['x'] ?? 0);
            $record->ypos = $this->clamp_percent($data['y'] ?? 0);
            $record->width = isset($data['width']) && $data['width'] !== '' && $data['width'] !== null
                ? $this->clamp_percent($data['width']) : null;
            $record->height = isset($data['height']) && $data['height'] !== '' && $data['height'] !== null
                ? $this->clamp_percent($data['height']) : null;
            $record->pathdata = null;
        }

        $record->id = $DB->insert_record('block_exaport_pdfannot', $record);

        return $this->export_one($record);
    }

    /**
     * Reposition/resize an existing annotation (drag-to-move, drag-to-resize, or moving a
     * whole pen stroke). Only the author or a user with full markup capability may edit.
     *
     * @param int $id
     * @param array $data any of x, y, width, height, pathdata - only provided keys change
     * @return array exported annotation
     */
    public function update_annotation(int $id, array $data): array {
        global $DB, $USER;

        $record = $DB->get_record('block_exaport_pdfannot',
            ['id' => $id, 'itemid' => $this->item->id], '*', MUST_EXIST);

        if ((int)$record->userid !== (int)$USER->id && !$this->can_manage_all()) {
            throw new \moodle_exception('nopermissions', 'error', '', 'edit annotation');
        }

        $update = new \stdClass();
        $update->id = $id;
        $update->timemodified = time();

        if ($record->annotype === 'pen' && isset($data['pathdata'])) {
            $points = $this->clean_pathdata($data['pathdata']);
            $bbox = $this->bounding_box($points);
            $update->pathdata = json_encode($points);
            $update->xpos = $bbox['x'];
            $update->ypos = $bbox['y'];
            $update->width = $bbox['width'];
            $update->height = $bbox['height'];
        } else {
            if (isset($data['x'])) {
                $update->xpos = $this->clamp_percent($data['x']);
            }
            if (isset($data['y'])) {
                $update->ypos = $this->clamp_percent($data['y']);
            }
            if (isset($data['width']) && $data['width'] !== '') {
                $update->width = $this->clamp_percent($data['width']);
            }
            if (isset($data['height']) && $data['height'] !== '') {
                $update->height = $this->clamp_percent($data['height']);
            }
        }

        $DB->update_record('block_exaport_pdfannot', $update);

        $record = $DB->get_record('block_exaport_pdfannot', ['id' => $id], '*', MUST_EXIST);
        return $this->export_one($record);
    }

    /**
     * Delete an annotation. Only the author or a user with full markup capability may delete.
     *
     * @param int $id
     */
    public function delete_annotation(int $id): void {
        global $DB, $USER;

        $record = $DB->get_record('block_exaport_pdfannot',
            ['id' => $id, 'itemid' => $this->item->id], '*', MUST_EXIST);

        if ((int)$record->userid !== (int)$USER->id && !$this->can_manage_all()) {
            throw new \moodle_exception('nopermissions', 'error', '', 'delete annotation');
        }

        $DB->delete_records('block_exaport_pdfannot', ['id' => $id]);
    }

    /**
     * Toggle the resolved flag on an annotation.
     *
     * @param int $id
     * @param bool $resolved
     */
    public function set_resolved(int $id, bool $resolved): void {
        global $DB;

        if (!$this->can_annotate()) {
            throw new \moodle_exception('nopermissions', 'error', '', 'resolve annotation');
        }

        $DB->get_record('block_exaport_pdfannot', ['id' => $id, 'itemid' => $this->item->id], 'id', MUST_EXIST);

        $DB->update_record('block_exaport_pdfannot', (object)[
            'id' => $id,
            'resolved' => $resolved ? 1 : 0,
            'timemodified' => time(),
        ]);
    }

    /**
     * Export a DB record (or freshly-saved stdClass) into the array shape sent to the client.
     *
     * @param \stdClass $record
     * @return array
     */
    protected function export_one($record): array {
        global $USER;

        static $usercache = [];
        $userid = (int)$record->userid;
        if (!isset($usercache[$userid])) {
            $usercache[$userid] = \core_user::get_user($userid) ?: null;
        }
        $author = $usercache[$userid];

        return [
            'id' => (int)$record->id,
            'page' => (int)$record->page,
            'x' => (float)$record->xpos,
            'y' => (float)$record->ypos,
            'width' => $record->width !== null ? (float)$record->width : null,
            'height' => $record->height !== null ? (float)$record->height : null,
            'type' => $record->annotype,
            'colour' => $record->colour,
            'pathdata' => !empty($record->pathdata) ? json_decode($record->pathdata, true) : null,
            'content' => $record->content,
            'ownerid' => $userid,
            'ownername' => $author ? fullname($author) : get_string('deleteduser', 'moodle'),
            'resolved' => (bool)$record->resolved,
            'timecreated' => (int)$record->timecreated,
            'candelete' => ($userid === (int)$USER->id) || $this->can_manage_all(),
            'ismine' => $userid === (int)$USER->id,
        ];
    }

    /**
     * Clamp a coordinate/size to a sane 0-100 percentage range.
     *
     * @param mixed $value
     * @return float
     */
    protected function clamp_percent($value): float {
        $value = (float)$value;
        if ($value < 0) {
            return 0.0;
        }
        if ($value > 100) {
            return 100.0;
        }
        return round($value, 4);
    }

    /**
     * Only accept well-formed hex colours, falling back to the default highlight colour.
     *
     * @param string $colour
     * @return string
     */
    protected function clean_colour($colour): string {
        $colour = (string)$colour;
        if (preg_match('/^#[0-9a-fA-F]{6}$/', $colour)) {
            return $colour;
        }
        return '#ffe066';
    }

    /**
     * Parse + sanitise a freehand pen stroke sent as a JSON string of [{x,y}, ...] points.
     *
     * @param mixed $raw JSON-encoded string from the client
     * @return array clamped [['x' => float, 'y' => float], ...] points
     */
    protected function clean_pathdata($raw): array {
        if (is_string($raw)) {
            $decoded = json_decode($raw, true);
        } else if (is_array($raw)) {
            $decoded = $raw;
        } else {
            $decoded = null;
        }

        if (!is_array($decoded) || count($decoded) < 2) {
            throw new \invalid_parameter_exception('pathdata must be an array of at least 2 points');
        }

        // Cap stroke complexity so a single annotation can't bloat storage/rendering.
        if (count($decoded) > 2000) {
            $decoded = array_slice($decoded, 0, 2000);
        }

        $points = [];
        foreach ($decoded as $point) {
            if (!is_array($point) || !isset($point['x'], $point['y'])) {
                continue;
            }
            $points[] = [
                'x' => $this->clamp_percent($point['x']),
                'y' => $this->clamp_percent($point['y']),
            ];
        }

        if (count($points) < 2) {
            throw new \invalid_parameter_exception('pathdata must contain at least 2 valid points');
        }

        return $points;
    }

    /**
     * Compute the bounding box of a pen stroke's points, for hit-testing/bookkeeping.
     *
     * @param array $points [['x' => float, 'y' => float], ...]
     * @return array ['x' => float, 'y' => float, 'width' => float, 'height' => float]
     */
    protected function bounding_box(array $points): array {
        $xs = array_column($points, 'x');
        $ys = array_column($points, 'y');
        $minx = min($xs);
        $miny = min($ys);
        return [
            'x' => $minx,
            'y' => $miny,
            'width' => max($xs) - $minx,
            'height' => max($ys) - $miny,
        ];
    }
}
