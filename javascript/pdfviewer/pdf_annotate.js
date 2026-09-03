/* Inline PDF viewer + annotation layer for block_exaport.
 *
 * Renders each ".exaport-pdf-viewer" container using pdf.js and overlays
 * click-to-comment pins / drag-to-highlight markers backed by
 * ajax_pdf_annotations.php. Vanilla JS, no build step - loaded via a plain
 * <script> tag emitted inline by lib/lib.php::block_exaport_render_pdf_viewer(),
 * since this renders deep in the page body where Moodle's $PAGE->requires
 * queue is unreliable.
 */
(function () {
    'use strict';

    var PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    var DRAG_THRESHOLD = 8; // px, below this a pointer down/up pair counts as a "click" (pin), not a drag (highlight).

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

    function fmtDate(unixtime) {
        var d = new Date(unixtime * 1000);
        return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
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
            loaderror: container.getAttribute('data-str-loaderror')
        };

        this.canvas = container.querySelector('.exaport-pdf-canvas');
        this.annotLayer = container.querySelector('.exaport-pdf-annotlayer');
        this.pageNumEl = container.querySelector('.exaport-pdf-pagenum');
        this.pageCountEl = container.querySelector('.exaport-pdf-pagecount');
        this.sidebarList = container.querySelector('.exaport-pdf-annotlist');
        this.loadingEl = container.querySelector('.exaport-pdf-loading');
        this.prevBtn = container.querySelector('.exaport-pdf-prev');
        this.nextBtn = container.querySelector('.exaport-pdf-next');

        this.pdfDoc = null;
        this.pageNum = 1;
        this.numPages = 0;
        this.annotations = [];
        this.activePopup = null;

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
            var scale = Math.min(2, Math.max(0.5, containerWidth / unscaled.width));
            var viewport = page.getViewport({scale: scale});

            self.canvas.width = viewport.width;
            self.canvas.height = viewport.height;
            self.annotLayer.style.width = viewport.width + 'px';
            self.annotLayer.style.height = viewport.height + 'px';

            var ctx = self.canvas.getContext('2d');
            page.render({canvasContext: ctx, viewport: viewport}).promise.then(function () {
                self.drawMarkers();
                self.renderSidebar();
                self.bindCanvasEvents();
            });
        });
    };

    Viewer.prototype.bindCanvasEvents = function () {
        var self = this;
        if (this._eventsBound) {
            return;
        }
        this._eventsBound = true;

        var startX = null;
        var startY = null;
        var startClientX = null;
        var startClientY = null;

        function pointFromEvent(evt) {
            var rect = self.canvas.getBoundingClientRect();
            var x = (evt.clientX - rect.left) / rect.width * 100;
            var y = (evt.clientY - rect.top) / rect.height * 100;
            return {x: Math.max(0, Math.min(100, x)), y: Math.max(0, Math.min(100, y))};
        }

        this.canvas.addEventListener('pointerdown', function (evt) {
            if (!self.canAnnotate) {
                return;
            }
            self.closePopup();
            startClientX = evt.clientX;
            startClientY = evt.clientY;
            var p = pointFromEvent(evt);
            startX = p.x;
            startY = p.y;
        });

        this.canvas.addEventListener('pointerup', function (evt) {
            if (!self.canAnnotate || startX === null) {
                return;
            }
            var dx = evt.clientX - startClientX;
            var dy = evt.clientY - startClientY;
            var dist = Math.sqrt(dx * dx + dy * dy);
            var endPoint = pointFromEvent(evt);

            if (dist < DRAG_THRESHOLD) {
                self.openCreatePopup({type: 'comment', x: startX, y: startY}, evt.clientX, evt.clientY);
            } else {
                var rect = {
                    x: Math.min(startX, endPoint.x),
                    y: Math.min(startY, endPoint.y),
                    width: Math.abs(endPoint.x - startX),
                    height: Math.abs(endPoint.y - startY)
                };
                self.openCreatePopup(Object.assign({type: 'highlight'}, rect), evt.clientX, evt.clientY);
            }
            startX = null;
            startY = null;
        });
    };

    Viewer.prototype.pageAnnotations = function () {
        var self = this;
        return this.annotations.filter(function (a) {
            return a.page === self.pageNum;
        });
    };

    Viewer.prototype.drawMarkers = function () {
        var self = this;
        this.annotLayer.innerHTML = '';

        if (!this.canAnnotate) {
            var hint = el('p', 'exaport-pdf-hint', this.str.viewonly);
            // Non-blocking hint, appended once above the layer via sidebar instead of canvas to avoid clutter.
            hint.style.display = 'none';
        }

        this.pageAnnotations().forEach(function (annot) {
            var marker;
            if (annot.type === 'highlight' && annot.width) {
                marker = el('div', 'exaport-pdf-highlight');
                marker.style.left = annot.x + '%';
                marker.style.top = annot.y + '%';
                marker.style.width = annot.width + '%';
                marker.style.height = annot.height + '%';
                if (annot.colour) {
                    marker.style.background = self.hexToRgba(annot.colour, 0.4);
                }
            } else {
                marker = el('div', 'exaport-pdf-pin');
                marker.style.left = annot.x + '%';
                marker.style.top = annot.y + '%';
            }
            if (annot.resolved) {
                marker.classList.add('is-resolved');
            }
            marker.setAttribute('data-annot-id', annot.id);
            marker.title = annot.ownername + ': ' + annot.content;
            marker.addEventListener('click', function (evt) {
                evt.stopPropagation();
                self.openViewPopup(annot, evt.clientX, evt.clientY, marker);
            });
            self.annotLayer.appendChild(marker);
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
            meta.appendChild(el('span', null, annot.ownername + ' \u00b7 p.' + annot.page));
            meta.appendChild(el('span', null, fmtDate(annot.timecreated)));
            li.appendChild(meta);

            li.appendChild(el('p', 'exaport-pdf-annot-text', annot.content));

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

    Viewer.prototype.closePopup = function () {
        if (this.activePopup && this.activePopup.parentNode) {
            this.activePopup.parentNode.removeChild(this.activePopup);
        }
        this.activePopup = null;
    };

    Viewer.prototype.positionPopup = function (popup, clientX, clientY) {
        var wrapRect = this.canvas.parentNode.getBoundingClientRect();
        var left = clientX - wrapRect.left;
        var top = clientY - wrapRect.top;
        // Keep the popup on-screen within the canvas wrapper.
        var maxLeft = wrapRect.width - 250;
        popup.style.left = Math.max(0, Math.min(left, maxLeft)) + 'px';
        popup.style.top = Math.max(0, top) + 'px';
    };

    Viewer.prototype.openCreatePopup = function (spec, clientX, clientY) {
        var self = this;
        this.closePopup();

        var popup = el('div', 'exaport-pdf-popup');
        var textarea = document.createElement('textarea');
        textarea.placeholder = this.str.hint;
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
            if (!content) {
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
        popup.appendChild(el('p', 'exaport-pdf-annot-text', annot.content));

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

    Viewer.prototype.createAnnotation = function (spec, content) {
        var self = this;
        var params = Object.assign(this.baseParams(), {
            action: 'save',
            page: this.pageNum,
            x: spec.x,
            y: spec.y,
            width: spec.width || '',
            height: spec.height || '',
            type: spec.type,
            content: content
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
