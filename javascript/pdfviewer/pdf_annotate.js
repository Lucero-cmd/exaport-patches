/* Inline PDF viewer + annotation layer for block_exaport.
 *
 * Renders each ".exaport-pdf-viewer" container using pdf.js and overlays three kinds of
 * teacher markup: comment pins, drag-drawn highlight rectangles, and freehand pen strokes.
 * Existing annotations can be dragged to move and (highlights) resized. Backed by
 * ajax_pdf_annotations.php. Vanilla JS, no build step - loaded via a plain <script> tag
 * emitted inline by lib/lib.php::block_exaport_render_pdf_viewer(), since this renders
 * deep in the page body where Moodle's $PAGE->requires queue is unreliable.
 */
(function () {
    'use strict';

    var PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    var DRAG_THRESHOLD = 8; // px, below this a pointer down/up pair counts as a "click", not a drag.
    var ZOOM_MIN = 0.5;
    var ZOOM_MAX = 3;
    var ZOOM_STEP = 0.25;
    var PEN_STROKE_WIDTH = 0.6; // in viewBox units (0-100 = full page width), independent of zoom.

    function whenPdfJsReady(callback, onTimeout, attemptsLeft) {
        if (typeof window.pdfjsLib !== 'undefined') {
            if (!window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
                window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
            }
            callback();
            return;
        }
        attemptsLeft = attemptsLeft === undefined ? 25 : attemptsLeft;
        if (attemptsLeft <= 0) {
            if (onTimeout) {
                onTimeout();
            }
            return;
        }
        window.setTimeout(function () {
            whenPdfJsReady(callback, onTimeout, attemptsLeft - 1);
        }, 200);
    }

    function qs(params) {
        var pairs = [];
        Object.keys(params).forEach(function (key) {
            if (params[key] === null || params[key] === undefined) {
                return;
            }
            pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(params[key]));
        });
        return pairs.join('&');
    }

    function ajax(url, method, params) {
        var opts = {
            method: method,
            credentials: 'same-origin'
        };
        var target = url;
        if (method === 'GET') {
            target += (url.indexOf('?') === -1 ? '?' : '&') + qs(params);
        } else {
            opts.headers = {'Content-Type': 'application/x-www-form-urlencoded'};
            opts.body = qs(params);
        }
        return fetch(target, opts).then(function (resp) {
            return resp.json();
        }).then(function (data) {
            if (!data || data.success !== true) {
                throw new Error((data && data.error) || 'Request failed');
            }
            return data;
        });
    }

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) {
            node.className = className;
        }
        if (text !== undefined && text !== null) {
            node.textContent = text;
        }
        return node;
    }

    function svgEl(tag, attrs) {
        var node = document.createElementNS('http://www.w3.org/2000/svg', tag);
        if (attrs) {
            Object.keys(attrs).forEach(function (key) {
                node.setAttribute(key, attrs[key]);
            });
        }
        return node;
    }

    function fmtDate(unixtime) {
        var d = new Date(unixtime * 1000);
        return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
    }

    function clamp(v, min, max) {
        return Math.max(min, Math.min(max, v));
    }

    function pointsToAttr(points) {
        return points.map(function (p) { return p.x + ',' + p.y; }).join(' ');
    }

    function Viewer(container) {
        this.container = container;
        this.pdfUrl = container.getAttribute('data-pdf-url');
        this.ajaxUrl = container.getAttribute('data-ajax-url');
        this.itemId = container.getAttribute('data-item-id');
        this.access = container.getAttribute('data-access');
        this.fileHash = container.getAttribute('data-file-hash');
        this.sesskey = container.getAttribute('data-sesskey');
        this.canAnnotate = container.getAttribute('data-can-annotate') === '1';
        this.str = {
            none: container.getAttribute('data-str-none'),
            hint: container.getAttribute('data-str-hint'),
            viewonly: container.getAttribute('data-str-viewonly'),
            save: container.getAttribute('data-str-save'),
            cancel: container.getAttribute('data-str-cancel'),
            del: container.getAttribute('data-str-delete'),
            resolve: container.getAttribute('data-str-resolve'),
            unresolve: container.getAttribute('data-str-unresolve'),
            confirmdelete: container.getAttribute('data-str-confirmdelete'),
            loaderror: container.getAttribute('data-str-loaderror'),
            hintoptional: container.getAttribute('data-str-hintoptional')
        };

        this.canvas = container.querySelector('.exaport-pdf-canvas');
        this.pensvg = container.querySelector('.exaport-pdf-pensvg');
        this.annotLayer = container.querySelector('.exaport-pdf-annotlayer');
        this.pageNumEl = container.querySelector('.exaport-pdf-pagenum');
        this.pageCountEl = container.querySelector('.exaport-pdf-pagecount');
        this.sidebarList = container.querySelector('.exaport-pdf-annotlist');
        this.loadingEl = container.querySelector('.exaport-pdf-loading');
        this.prevBtn = container.querySelector('.exaport-pdf-prev');
        this.nextBtn = container.querySelector('.exaport-pdf-next');
        this.zoomInBtn = container.querySelector('.exaport-pdf-zoomin');
        this.zoomOutBtn = container.querySelector('.exaport-pdf-zoomout');
        this.zoomResetBtn = container.querySelector('.exaport-pdf-zoomreset');
        this.zoomLevelEl = container.querySelector('.exaport-pdf-zoomlevel');
        this.toolButtons = container.querySelectorAll('.exaport-pdf-tool');
        this.colorPicker = container.querySelector('.exaport-pdf-colorpicker');

        this.pdfDoc = null;
        this.pageNum = 1;
        this.numPages = 0;
        this.annotations = [];
        this.activePopup = null;

        this.tool = 'comment';
        this.color = this.colorPicker ? this.colorPicker.value : '#ffe066';
        this.zoom = 1;
        this.fitScale = 1;
        this._drawingPoints = null;
        this._previewPolyline = null;

        this.bindToolbar();
    }

    Viewer.prototype.baseParams = function () {
        return {
            itemid: this.itemId,
            access: this.access,
            inst: this.fileHash,
            sesskey: this.sesskey
        };
    };

    Viewer.prototype.bindToolbar = function () {
        var self = this;

        this.prevBtn.addEventListener('click', function () {
            if (self.pageNum > 1) {
                self.renderPage(self.pageNum - 1);
            }
        });
        this.nextBtn.addEventListener('click', function () {
            if (self.pageNum < self.numPages) {
                self.renderPage(self.pageNum + 1);
            }
        });

        if (this.zoomInBtn) {
            this.zoomInBtn.addEventListener('click', function () {
                self.setZoom(self.zoom + ZOOM_STEP);
            });
            this.zoomOutBtn.addEventListener('click', function () {
                self.setZoom(self.zoom - ZOOM_STEP);
            });
            this.zoomResetBtn.addEventListener('click', function () {
                self.setZoom(1);
            });
        }

        this.toolButtons.forEach(function (btn) {
            btn.addEventListener('click', function () {
                self.tool = btn.getAttribute('data-tool');
                self.toolButtons.forEach(function (b) {
                    b.classList.toggle('is-active', b === btn);
                });
                self.closePopup();
            });
        });

        if (this.colorPicker) {
            this.colorPicker.addEventListener('input', function () {
                self.color = this.value;
            });
        }
    };

    Viewer.prototype.setZoom = function (zoom) {
        this.zoom = clamp(Math.round(zoom * 100) / 100, ZOOM_MIN, ZOOM_MAX);
        if (this.zoomLevelEl) {
            this.zoomLevelEl.textContent = Math.round(this.zoom * 100) + '%';
        }
        if (this.pdfDoc) {
            this.renderPage(this.pageNum);
        }
    };

    Viewer.prototype.init = function () {
        var self = this;
        whenPdfJsReady(function () {
            window.pdfjsLib.getDocument(self.pdfUrl).promise.then(function (pdfDoc) {
                self.pdfDoc = pdfDoc;
                self.numPages = pdfDoc.numPages;
                self.pageCountEl.textContent = self.numPages;
                self.loadingEl.style.display = 'none';

                return self.loadAnnotations().then(function () {
                    self.renderPage(1);
                });
            }).catch(function (err) {
                self.showLoadError(err);
            });
        }, function () {
            self.showLoadError(new Error('pdf.js library failed to load (CDN blocked or unreachable?)'));
        });
    };

    Viewer.prototype.showLoadError = function (err) {
        this.loadingEl.textContent = this.str.loaderror;
        this.loadingEl.className = 'exaport-pdf-error';
        window.console && window.console.error && window.console.error('exaport pdf viewer', err);
    };

    Viewer.prototype.loadAnnotations = function () {
        var self = this;
        return ajax(this.ajaxUrl, 'GET', Object.assign({action: 'list'}, this.baseParams())).then(function (data) {
            self.annotations = data.annotations || [];
            self.canAnnotate = !!data.canannotate;
            self.container.setAttribute('data-can-annotate', self.canAnnotate ? '1' : '0');
        }).catch(function () {
            self.annotations = [];
        });
    };

    Viewer.prototype.renderPage = function (num) {
        var self = this;
        this.closePopup();
        this.pageNum = num;
        this.pageNumEl.textContent = num;
        this.prevBtn.disabled = num <= 1;
        this.nextBtn.disabled = num >= this.numPages;

        this.pdfDoc.getPage(num).then(function (page) {
            var containerWidth = self.canvas.parentNode.clientWidth || 600;
            var unscaled = page.getViewport({scale: 1});
            self.fitScale = clamp(containerWidth / unscaled.width, 0.3, 1.5);
            var scale = self.fitScale * self.zoom;
            var viewport = page.getViewport({scale: scale});

            self.canvas.width = viewport.width;
            self.canvas.height = viewport.height;
            self.canvas.style.width = viewport.width + 'px';
            self.canvas.style.height = viewport.height + 'px';
            self.annotLayer.style.width = viewport.width + 'px';
            self.annotLayer.style.height = viewport.height + 'px';
            self.pensvg.style.width = viewport.width + 'px';
            self.pensvg.style.height = viewport.height + 'px';

            var ctx = self.canvas.getContext('2d');
            page.render({canvasContext: ctx, viewport: viewport}).promise.then(function () {
                self.drawMarkers();
                self.renderSidebar();
                self.bindCanvasEvents();
            });
        });
    };

    // -- coordinate helpers --------------------------------------------------------------

    Viewer.prototype.pointFromEvent = function (evt) {
        var rect = this.canvas.getBoundingClientRect();
        var x = (evt.clientX - rect.left) / rect.width * 100;
        var y = (evt.clientY - rect.top) / rect.height * 100;
        return {x: clamp(x, 0, 100), y: clamp(y, 0, 100)};
    };

    Viewer.prototype.pixelDeltaToPercent = function (dxPx, dyPx) {
        var rect = this.canvas.getBoundingClientRect();
        return {
            x: dxPx / rect.width * 100,
            y: dyPx / rect.height * 100
        };
    };

    // -- creating new annotations on the canvas -------------------------------------------

    Viewer.prototype.bindCanvasEvents = function () {
        var self = this;
        if (this._eventsBound) {
            return;
        }
        this._eventsBound = true;

        var startPoint = null;
        var startClientX = null;
        var startClientY = null;

        this.canvas.addEventListener('pointerdown', function (evt) {
            if (!self.canAnnotate || self.activePopup) {
                return;
            }
            self.canvas.setPointerCapture(evt.pointerId);
            startClientX = evt.clientX;
            startClientY = evt.clientY;
            startPoint = self.pointFromEvent(evt);

            if (self.tool === 'pen') {
                self._drawingPoints = [startPoint];
                self._previewPolyline = svgEl('polyline', {
                    points: pointsToAttr(self._drawingPoints),
                    stroke: self.color,
                    'stroke-width': PEN_STROKE_WIDTH,
                    opacity: 0.85
                });
                self.pensvg.appendChild(self._previewPolyline);
            }
        });

        this.canvas.addEventListener('pointermove', function (evt) {
            if (self.tool === 'pen' && self._drawingPoints) {
                self._drawingPoints.push(self.pointFromEvent(evt));
                self._previewPolyline.setAttribute('points', pointsToAttr(self._drawingPoints));
            }
        });

        this.canvas.addEventListener('pointerup', function (evt) {
            if (!self.canAnnotate || startPoint === null) {
                return;
            }

            if (self.tool === 'pen') {
                if (self._previewPolyline && self._previewPolyline.parentNode) {
                    self._previewPolyline.parentNode.removeChild(self._previewPolyline);
                }
                self._previewPolyline = null;
                var points = self._drawingPoints;
                self._drawingPoints = null;
                if (points && points.length === 1) {
                    points.push({x: points[0].x, y: points[0].y}); // quick tap -> tiny dot stroke.
                }
                if (points && points.length >= 2) {
                    self.openCreatePopup({type: 'pen', pathdata: JSON.stringify(points)}, evt.clientX, evt.clientY);
                }
                startPoint = null;
                return;
            }

            var dx = evt.clientX - startClientX;
            var dy = evt.clientY - startClientY;
            var dist = Math.sqrt(dx * dx + dy * dy);
            var endPoint = self.pointFromEvent(evt);

            if (self.tool === 'highlight') {
                var rect;
                if (dist < DRAG_THRESHOLD) {
                    // A plain tap with the highlight tool selected: drop a small default box
                    // centred on the tap instead of requiring a precise drag every time.
                    rect = {
                        x: clamp(startPoint.x - 5, 0, 95),
                        y: clamp(startPoint.y - 2, 0, 96),
                        width: 10,
                        height: 4
                    };
                } else {
                    rect = {
                        x: Math.min(startPoint.x, endPoint.x),
                        y: Math.min(startPoint.y, endPoint.y),
                        width: Math.abs(endPoint.x - startPoint.x),
                        height: Math.abs(endPoint.y - startPoint.y)
                    };
                }
                self.openCreatePopup(Object.assign({type: 'highlight'}, rect), evt.clientX, evt.clientY);
            } else {
                // Comment tool: always anchor on the initial tap point, drag distance ignored.
                self.openCreatePopup({type: 'comment', x: startPoint.x, y: startPoint.y}, evt.clientX, evt.clientY);
            }
            startPoint = null;
        });
    };

    Viewer.prototype.pageAnnotations = function () {
        var self = this;
        return this.annotations.filter(function (a) {
            return a.page === self.pageNum;
        });
    };

    // -- rendering existing annotations ----------------------------------------------------

    Viewer.prototype.drawMarkers = function () {
        var self = this;
        this.annotLayer.innerHTML = '';
        this.pensvg.innerHTML = '';

        this.pageAnnotations().forEach(function (annot) {
            if (annot.type === 'pen' && annot.pathdata) {
                self.drawPenStroke(annot);
            } else if (annot.type === 'highlight' && annot.width) {
                self.drawHighlight(annot);
            } else {
                self.drawPin(annot);
            }
        });
    };

    Viewer.prototype.drawPin = function (annot) {
        var self = this;
        var marker = el('div', 'exaport-pdf-pin');
        marker.style.left = annot.x + '%';
        marker.style.top = annot.y + '%';
        marker.style.background = annot.colour || '#ffbe0b';
        if (annot.resolved) {
            marker.classList.add('is-resolved');
        }
        marker.setAttribute('data-annot-id', annot.id);
        marker.title = annot.ownername + ': ' + annot.content;

        this.attachMarkerDrag(marker, annot, {
            onClick: function (evt) {
                self.openViewPopup(annot, evt.clientX, evt.clientY, marker);
            },
            onMove: function (dxPct, dyPct) {
                marker.style.left = clamp(annot.x + dxPct, 0, 100) + '%';
                marker.style.top = clamp(annot.y + dyPct, 0, 100) + '%';
            },
            onMoveEnd: function (dxPct, dyPct) {
                self.persistUpdate(annot, {
                    x: clamp(annot.x + dxPct, 0, 100),
                    y: clamp(annot.y + dyPct, 0, 100)
                });
            }
        });

        this.annotLayer.appendChild(marker);
    };

    Viewer.prototype.drawHighlight = function (annot) {
        var self = this;
        var marker = el('div', 'exaport-pdf-highlight');
        marker.style.left = annot.x + '%';
        marker.style.top = annot.y + '%';
        marker.style.width = annot.width + '%';
        marker.style.height = annot.height + '%';
        marker.style.background = this.hexToRgba(annot.colour || '#ffe066', 0.4);
        if (annot.resolved) {
            marker.classList.add('is-resolved');
        }
        marker.setAttribute('data-annot-id', annot.id);
        marker.title = annot.ownername + (annot.content ? ': ' + annot.content : '');

        this.attachMarkerDrag(marker, annot, {
            onClick: function (evt) {
                self.openViewPopup(annot, evt.clientX, evt.clientY, marker);
            },
            onMove: function (dxPct, dyPct) {
                marker.style.left = clamp(annot.x + dxPct, 0, 100 - annot.width) + '%';
                marker.style.top = clamp(annot.y + dyPct, 0, 100 - annot.height) + '%';
            },
            onMoveEnd: function (dxPct, dyPct) {
                self.persistUpdate(annot, {
                    x: clamp(annot.x + dxPct, 0, 100 - annot.width),
                    y: clamp(annot.y + dyPct, 0, 100 - annot.height)
                });
            }
        });

        if (annot.candelete) {
            var handle = el('div', 'exaport-pdf-resizehandle');
            var startW = null;
            var startH = null;
            var startClientX = null;
            var startClientY = null;

            handle.addEventListener('pointerdown', function (evt) {
                evt.stopPropagation();
                handle.setPointerCapture(evt.pointerId);
                startW = annot.width;
                startH = annot.height;
                startClientX = evt.clientX;
                startClientY = evt.clientY;
            });
            handle.addEventListener('pointermove', function (evt) {
                if (startW === null) {
                    return;
                }
                evt.stopPropagation();
                var d = self.pixelDeltaToPercent(evt.clientX - startClientX, evt.clientY - startClientY);
                var newW = clamp(startW + d.x, 2, 100 - annot.x);
                var newH = clamp(startH + d.y, 2, 100 - annot.y);
                marker.style.width = newW + '%';
                marker.style.height = newH + '%';
            });
            handle.addEventListener('pointerup', function (evt) {
                if (startW === null) {
                    return;
                }
                evt.stopPropagation();
                var d = self.pixelDeltaToPercent(evt.clientX - startClientX, evt.clientY - startClientY);
                var newW = clamp(startW + d.x, 2, 100 - annot.x);
                var newH = clamp(startH + d.y, 2, 100 - annot.y);
                startW = null;
                startH = null;
                self.persistUpdate(annot, {width: newW, height: newH});
            });

            marker.appendChild(handle);
        }

        this.annotLayer.appendChild(marker);
    };

    Viewer.prototype.drawPenStroke = function (annot) {
        var self = this;
        var points = annot.pathdata;

        var polyline = svgEl('polyline', {
            points: pointsToAttr(points),
            stroke: annot.colour || '#ffe066',
            'stroke-width': PEN_STROKE_WIDTH,
            opacity: annot.resolved ? 0.45 : 0.85
        });
        this.pensvg.appendChild(polyline);

        // Invisible grab handle covering the stroke's bounding box, for click/drag/view.
        var handle = el('div', 'exaport-pdf-penhandle');
        handle.style.left = annot.x + '%';
        handle.style.top = annot.y + '%';
        handle.style.width = Math.max(annot.width, 2) + '%';
        handle.style.height = Math.max(annot.height, 2) + '%';
        handle.setAttribute('data-annot-id', annot.id);
        handle.title = annot.ownername + (annot.content ? ': ' + annot.content : '');

        this.attachMarkerDrag(handle, annot, {
            onClick: function (evt) {
                self.openViewPopup(annot, evt.clientX, evt.clientY, handle);
            },
            onMove: function (dxPct, dyPct) {
                handle.style.left = clamp(annot.x + dxPct, 0, 100) + '%';
                handle.style.top = clamp(annot.y + dyPct, 0, 100) + '%';
                var translated = points.map(function (p) {
                    return {x: clamp(p.x + dxPct, 0, 100), y: clamp(p.y + dyPct, 0, 100)};
                });
                polyline.setAttribute('points', pointsToAttr(translated));
            },
            onMoveEnd: function (dxPct, dyPct) {
                var translated = points.map(function (p) {
                    return {x: clamp(p.x + dxPct, 0, 100), y: clamp(p.y + dyPct, 0, 100)};
                });
                self.persistUpdate(annot, {pathdata: JSON.stringify(translated)});
            }
        });

        this.annotLayer.appendChild(handle);
    };

    /**
     * Wire up click-vs-drag handling for an existing annotation's marker/handle element.
     * Always allows a plain click (any user) to view it; only lets candelete === true
     * annotations actually be dragged.
     */
    Viewer.prototype.attachMarkerDrag = function (markerEl, annot, handlers) {
        var self = this;
        var startClientX = null;
        var startClientY = null;
        var dragging = false;

        markerEl.addEventListener('pointerdown', function (evt) {
            evt.stopPropagation();
            markerEl.setPointerCapture(evt.pointerId);
            startClientX = evt.clientX;
            startClientY = evt.clientY;
            dragging = false;
        });

        markerEl.addEventListener('pointermove', function (evt) {
            if (startClientX === null || !annot.candelete) {
                return;
            }
            evt.stopPropagation();
            var dx = evt.clientX - startClientX;
            var dy = evt.clientY - startClientY;
            if (!dragging && Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) {
                return;
            }
            dragging = true;
            var d = self.pixelDeltaToPercent(dx, dy);
            handlers.onMove(d.x, d.y);
        });

        markerEl.addEventListener('pointerup', function (evt) {
            if (startClientX === null) {
                return;
            }
            evt.stopPropagation();
            if (dragging) {
                var d = self.pixelDeltaToPercent(evt.clientX - startClientX, evt.clientY - startClientY);
                handlers.onMoveEnd(d.x, d.y);
            } else {
                handlers.onClick(evt);
            }
            startClientX = null;
            dragging = false;
        });
    };

    Viewer.prototype.hexToRgba = function (hex, alpha) {
        var m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
        if (!m) {
            return hex;
        }
        var r = parseInt(m[1], 16);
        var g = parseInt(m[2], 16);
        var b = parseInt(m[3], 16);
        return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
    };

    // -- sidebar ----------------------------------------------------------------------------

    Viewer.prototype.renderSidebar = function () {
        var self = this;
        this.sidebarList.innerHTML = '';

        if (!this.annotations.length) {
            this.sidebarList.appendChild(el('li', 'exaport-pdf-annot-empty', this.str.none));
            return;
        }

        this.annotations.forEach(function (annot) {
            var li = el('li');
            if (annot.resolved) {
                li.classList.add('is-resolved');
            }

            var meta = el('div', 'exaport-pdf-annot-meta');
            var typeLabel = annot.type === 'pen' ? '\u270f' : (annot.type === 'highlight' ? '\u25fb' : '\ud83d\udcac');
            meta.appendChild(el('span', null, typeLabel + ' ' + annot.ownername + ' \u00b7 p.' + annot.page));
            meta.appendChild(el('span', null, fmtDate(annot.timecreated)));
            li.appendChild(meta);

            if (annot.content) {
                li.appendChild(el('p', 'exaport-pdf-annot-text', annot.content));
            }

            var actions = el('div', 'exaport-pdf-annot-actions');

            var jumpBtn = el('button', null, '#' + annot.page);
            jumpBtn.type = 'button';
            jumpBtn.addEventListener('click', function () {
                if (annot.page !== self.pageNum) {
                    self.renderPage(annot.page);
                }
            });
            actions.appendChild(jumpBtn);

            if (self.canAnnotate) {
                var resolveBtn = el('button', null, annot.resolved ? self.str.unresolve : self.str.resolve);
                resolveBtn.type = 'button';
                resolveBtn.addEventListener('click', function () {
                    self.toggleResolved(annot);
                });
                actions.appendChild(resolveBtn);
            }

            if (annot.candelete) {
                var delBtn = el('button', null, self.str.del);
                delBtn.type = 'button';
                delBtn.addEventListener('click', function () {
                    self.deleteAnnotation(annot);
                });
                actions.appendChild(delBtn);
            }

            li.appendChild(actions);
            self.sidebarList.appendChild(li);
        });
    };

    // -- popups -------------------------------------------------------------------------------

    Viewer.prototype.closePopup = function () {
        if (this.activePopup && this.activePopup.parentNode) {
            this.activePopup.parentNode.removeChild(this.activePopup);
        }
        this.activePopup = null;
    };

    Viewer.prototype.positionPopup = function (popup, clientX, clientY) {
        var wrapRect = this.canvas.parentNode.getBoundingClientRect();
        var left = clientX - wrapRect.left + this.canvas.parentNode.scrollLeft;
        var top = clientY - wrapRect.top + this.canvas.parentNode.scrollTop;
        var maxLeft = this.canvas.parentNode.scrollWidth - 290; // keep the (now 280px-wide) popup on-screen
        popup.style.left = Math.max(0, Math.min(left, maxLeft)) + 'px';
        popup.style.top = Math.max(0, top) + 'px';
    };

    Viewer.prototype.openCreatePopup = function (spec, clientX, clientY) {
        var self = this;
        this.closePopup();

        var requireContent = spec.type === 'comment';

        var popup = el('div', 'exaport-pdf-popup');
        var textarea = document.createElement('textarea');
        textarea.placeholder = requireContent ? this.str.hint : this.str.hintoptional;
        popup.appendChild(textarea);

        var actions = el('div', 'exaport-pdf-popup-actions');
        var saveBtn = el('button', null, this.str.save);
        saveBtn.type = 'button';
        var cancelBtn = el('button', null, this.str.cancel);
        cancelBtn.type = 'button';
        cancelBtn.addEventListener('click', function () {
            self.closePopup();
        });
        saveBtn.addEventListener('click', function () {
            var content = textarea.value.trim();
            if (requireContent && !content) {
                return;
            }
            self.createAnnotation(spec, content);
        });
        actions.appendChild(cancelBtn);
        actions.appendChild(saveBtn);
        popup.appendChild(actions);

        this.canvas.parentNode.appendChild(popup);
        this.positionPopup(popup, clientX, clientY);
        this.activePopup = popup;
        textarea.focus();
    };

    Viewer.prototype.openViewPopup = function (annot, clientX, clientY, markerEl) {
        var self = this;
        this.closePopup();

        var popup = el('div', 'exaport-pdf-popup');
        var meta = el('div', 'exaport-pdf-annot-meta');
        meta.appendChild(el('span', null, annot.ownername));
        meta.appendChild(el('span', null, fmtDate(annot.timecreated)));
        popup.appendChild(meta);
        if (annot.content) {
            popup.appendChild(el('p', 'exaport-pdf-annot-text', annot.content));
        }

        var actions = el('div', 'exaport-pdf-popup-actions');
        var closeBtn = el('button', null, this.str.cancel);
        closeBtn.type = 'button';
        closeBtn.addEventListener('click', function () {
            self.closePopup();
        });
        actions.appendChild(closeBtn);

        if (this.canAnnotate) {
            var resolveBtn = el('button', null, annot.resolved ? this.str.unresolve : this.str.resolve);
            resolveBtn.type = 'button';
            resolveBtn.addEventListener('click', function () {
                self.toggleResolved(annot);
                self.closePopup();
            });
            actions.appendChild(resolveBtn);
        }

        if (annot.candelete) {
            var delBtn = el('button', null, this.str.del);
            delBtn.type = 'button';
            delBtn.addEventListener('click', function () {
                self.deleteAnnotation(annot);
                self.closePopup();
            });
            actions.appendChild(delBtn);
        }

        popup.appendChild(actions);
        markerEl.parentNode.appendChild(popup);
        this.positionPopup(popup, clientX, clientY);
        this.activePopup = popup;
    };

    // -- persistence ----------------------------------------------------------------------------

    Viewer.prototype.createAnnotation = function (spec, content) {
        var self = this;
        var params = Object.assign(this.baseParams(), {
            action: 'save',
            page: this.pageNum,
            x: spec.x || 0,
            y: spec.y || 0,
            width: spec.width,
            height: spec.height,
            type: spec.type,
            colour: this.color,
            content: content,
            pathdata: spec.pathdata
        });
        ajax(this.ajaxUrl, 'POST', params).then(function (data) {
            self.annotations.push(data.annotation);
            self.closePopup();
            self.drawMarkers();
            self.renderSidebar();
        }).catch(function (err) {
            window.alert(err.message || 'Could not save annotation');
        });
    };

    /**
     * Persist a move/resize for an existing annotation, then update local state in place
     * (rather than re-fetching the whole list) and redraw.
     */
    Viewer.prototype.persistUpdate = function (annot, changes) {
        var self = this;
        var params = Object.assign(this.baseParams(), {action: 'update', id: annot.id}, changes);
        ajax(this.ajaxUrl, 'POST', params).then(function (data) {
            Object.assign(annot, data.annotation);
            self.drawMarkers();
            self.renderSidebar();
        }).catch(function (err) {
            window.alert(err.message || 'Could not move annotation');
            self.drawMarkers(); // snap back to last-known-good position.
        });
    };

    Viewer.prototype.deleteAnnotation = function (annot) {
        var self = this;
        if (!window.confirm(this.str.confirmdelete)) {
            return;
        }
        var params = Object.assign(this.baseParams(), {action: 'delete', id: annot.id});
        ajax(this.ajaxUrl, 'POST', params).then(function () {
            self.annotations = self.annotations.filter(function (a) {
                return a.id !== annot.id;
            });
            self.closePopup();
            self.drawMarkers();
            self.renderSidebar();
        }).catch(function (err) {
            window.alert(err.message || 'Could not delete annotation');
        });
    };

    Viewer.prototype.toggleResolved = function (annot) {
        var self = this;
        var newResolved = annot.resolved ? 0 : 1;
        var params = Object.assign(this.baseParams(), {action: 'resolve', id: annot.id, resolved: newResolved});
        ajax(this.ajaxUrl, 'POST', params).then(function () {
            annot.resolved = !!newResolved;
            self.drawMarkers();
            self.renderSidebar();
        }).catch(function (err) {
            window.alert(err.message || 'Could not update annotation');
        });
    };

    function initAll() {
        var nodes = document.querySelectorAll('.exaport-pdf-viewer');
        nodes.forEach(function (node) {
            if (node._exaportPdfViewer) {
                return;
            }
            var viewer = new Viewer(node);
            node._exaportPdfViewer = viewer;
            viewer.init();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initAll);
    } else {
        initAll();
    }
}());
