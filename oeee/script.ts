import { compressToUint8Array } from "lz-string";

const LINETYPE_PEN = 1;
const DEFAULT_CANVAS_WIDTH = 640;
const DEFAULT_CANVAS_HEIGHT = 480;
const ALPHATYPE_PEN = 1;

const COLOR_SCHEMES = {
	'aka': {
		'pen': '#800000',
		'fill': '#f0e0d6',
	},
	'ao': {
		'pen': '#313768',
		'fill': '#d5e9f3',
	},
}

const DEFAULT_COLOR_SCHEME = 'aka';

export class Oeee {
	private canvas: HTMLCanvasElement;
	private size = 2;
	private colorScheme: keyof typeof COLOR_SCHEMES = DEFAULT_COLOR_SCHEME;
	private penColor = COLOR_SCHEMES[this.colorScheme].pen;
	private penOpacity = 255;
	private isDrawing = false;
	private lastX = 0;
	private lastY = 0;
	private lastState: ImageData | null = null; // Store only last state
	private redoState: ImageData | null = null; // Store only one redo state
	private _roundData: Uint8Array[] = [];
	private prevLine: number[][] | null = null;
	private aerr = 0;

	private mouseX = 0;
	private mouseY = 0;
	private prevMouseX = 0;
	private prevMouseY = 0;

	private zoom = 1;
	private zoomX = 0;
	private zoomY = 0;

	// biome-ignore lint/suspicious/noExplicitAny: <explanation>
	private items: any[] = [];
	private head = 0;

	private lastItems: any[] | null = null; // Add this to class properties
	private redoItems: any[] | null = null; // Add this to class properties

	private _initRoundData() {
		for (let r = 1; r <= 30; r++) {
			this._roundData[r] = new Uint8Array(r * r);
			const mask = this._roundData[r];
			let index = 0;
			for (let x = 0; x < r; x++) {
				for (let y = 0; y < r; y++) {
					const xx = x + 0.5 - r / 2.0;
					const yy = y + 0.5 - r / 2.0;
					mask[index++] = xx * xx + yy * yy <= (r * r) / 4 ? 1 : 0;
				}
			}
		}
		this._roundData[3][0] = 0;
		this._roundData[3][2] = 0;
		this._roundData[3][6] = 0;
		this._roundData[3][8] = 0;

		this._roundData[5][1] = 0;
		this._roundData[5][3] = 0;
		this._roundData[5][5] = 0;
		this._roundData[5][9] = 0;
		this._roundData[5][15] = 0;
		this._roundData[5][19] = 0;
		this._roundData[5][21] = 0;
		this._roundData[5][23] = 0;
	}

	public getThumbnail(type: string): Blob {
		if (type !== "animation") {
			const image = this.canvas.toDataURL(`image/${type}`);
			return this.dataURLtoBlob(image);
		}
		// Create a copy of items and remove the last empty array
		const itemsToExport = [...this.items];
		if (itemsToExport.length > 0 && Array.isArray(itemsToExport[itemsToExport.length - 1])
			&& itemsToExport[itemsToExport.length - 1].length === 0) {
			itemsToExport.pop();
		}

		const magic = "NEO ";
		const w = this.canvas.width;
		const h = this.canvas.height;

		const emptyCanvas = document.createElement("canvas");
		emptyCanvas.width = w;
		emptyCanvas.height = h;

		const restoreData = [
			"restore",
			this.canvas.toDataURL("image/png"),
			emptyCanvas.toDataURL("image/png"),
		];

		itemsToExport.push(restoreData);

		const data = JSON.stringify(itemsToExport);
		const compressedData = compressToUint8Array(data);

		return new Blob([
			magic,
			new Uint8Array([w % 0x100, Math.floor(w / 0x100)]),
			new Uint8Array([h % 0x100, Math.floor(h / 0x100)]),
			new Uint8Array(4),
			compressedData,
		]);
	}

	private dataURLtoBlob(dataURL: string): Blob {
		let byteString: string;
		if (dataURL.split(",")[0].indexOf("base64") >= 0) {
			byteString = atob(dataURL.split(",")[1]);
		} else {
			byteString = decodeURI(dataURL.split(",")[1]);
		}

		// write the bytes of the string to a typed array
		const ia = new Uint8Array(byteString.length);
		for (let i = 0; i < byteString.length; i++) {
			ia[i] = byteString.charCodeAt(i);
		}
		return new Blob([ia], { type: "image/png" });
	}

	// Add the shared hexToInt method
	private hexToInt(hex: string): number {
		const r = parseInt(hex.slice(1, 3), 16);
		const g = parseInt(hex.slice(3, 5), 16);
		const b = parseInt(hex.slice(5, 7), 16);
		// Use alpha = 255 (fully opaque)
		return (255 << 24) | (b << 16) | (g << 8) | r;  // ABGR format
	}

	constructor(container: HTMLElement) {
		this.canvas = document.createElement("canvas");
		this.canvas.id = "canvas";
		this.canvas.width = DEFAULT_CANVAS_WIDTH;
		this.canvas.height = DEFAULT_CANVAS_HEIGHT;
		this.canvas.style.imageRendering = "pixelated";

		this._initRoundData();

		container.appendChild(this.canvas);

		// Initialize with a flood fill
		const fillColorHex = COLOR_SCHEMES[this.colorScheme].fill;

		// Flood canvas with the color scheme's fill color
		const ctx = this.canvas.getContext("2d");
		if (ctx) {
			ctx.fillStyle = fillColorHex;
			ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
		}

		this.items = [
			[
				"floodFill",
				0, // layer
				0, // x
				0, // y
				this.hexToInt(fillColorHex), // Using shared method
			],
		];
		this.head++;
		this.items.push([]);

		this.setupEventListeners();
	}

	private _updateMousePosition(e: MouseEvent | TouchEvent | PointerEvent) {
		const rect = this.canvas.getBoundingClientRect();
		//  var x = (e.clientX !== undefined) ? e.clientX : e.touches[0].clientX;
		//  var y = (e.clientY !== undefined) ? e.clientY : e.touches[0].clientY;
		const pos = this.getCoordinates(e);
		const x = pos.x;
		const y = pos.y;

		if (this.zoom <= 0) this.zoom = 1; //なぜか0になることがあるので

		this.mouseX =
			(x - rect.left) / this.zoom +
			this.zoomX -
			(this.canvas.width * 0.5) / this.zoom;
		this.mouseY =
			(y - rect.top) / this.zoom +
			this.zoomY -
			(this.canvas.height * 0.5) / this.zoom;

		if (Number.isNaN(this.prevMouseX)) {
			this.prevMouseX = this.mouseX;
		}
		if (Number.isNaN(this.prevMouseY)) {
			this.prevMouseY = this.mouseY;
		}
	}

	private setupEventListeners() {
		// Undo/redo buttons
		const undoButton = document.getElementById("undo");
		const redoButton = document.getElementById("redo");
		if (undoButton) {
			undoButton.addEventListener("click", () => this.undo());
		}
		if (redoButton) {
			redoButton.addEventListener("click", () => this.redo());
		}

		// Color picker options
		const colorPickerOption1 = document.getElementById("color-picker-option-1");
		const colorPickerOption2 = document.getElementById("color-picker-option-2");

		const handleColorPickerClick = (
			element: HTMLElement | null,
			colorType: 'pen' | 'fill',
			selector: string,
		) => {
			if (element) {
				element.addEventListener("click", () => {
					const radio = document.querySelector(selector) as HTMLInputElement;
					if (radio) {
						radio.checked = true;
						this.penColor = COLOR_SCHEMES[this.colorScheme][colorType];
					}
				});
			}
		};

		handleColorPickerClick(
			colorPickerOption1,
			'pen',
			'input[id="color-picker-option-1"][value="color-picker"]',
		);

		handleColorPickerClick(
			colorPickerOption2,
			'fill',
			'input[id="color-picker-option-2"][value="color-picker"]',
		);

		// Size slider
		const sizeSlider = document.getElementById("size") as HTMLInputElement;
		const penSizeValue = document.getElementById(
			"pen-size-value",
		) as HTMLSpanElement;
		if (sizeSlider) {
			sizeSlider.addEventListener("input", () => {
				this.size = Number.parseInt(sizeSlider.value ?? "2");
				penSizeValue.textContent = this.size.toString();
			});
		}

		// Pointer events (pen)
		this.canvas.addEventListener("pointerdown", this.handleStart.bind(this));
		this.canvas.addEventListener("pointermove", this.handleMove.bind(this));
		this.canvas.addEventListener("pointerup", this.handleEnd.bind(this));
		this.canvas.addEventListener("pointercancel", this.handleEnd.bind(this));
		// Remove pointerleave handler

		// Touch events
		this.canvas.addEventListener("touchstart", this.handleStart.bind(this));
		this.canvas.addEventListener("touchmove", this.handleMove.bind(this));
		this.canvas.addEventListener("touchend", this.handleEnd.bind(this));
		this.canvas.addEventListener("touchcancel", this.handleEnd.bind(this));

		// Mouse events
		this.canvas.addEventListener("mousedown", this.handleStart.bind(this));
		this.canvas.addEventListener("mousemove", this.handleMove.bind(this));
		this.canvas.addEventListener("mouseup", this.handleEnd.bind(this));
		// Remove mouseleave handler

		// Add window-level event listeners to handle pointer/mouse up anywhere
		window.addEventListener("pointerup", this.handleEnd.bind(this));
		window.addEventListener("mouseup", this.handleEnd.bind(this));

		// Undo/Redo keyboard shortcuts
		document.addEventListener("keydown", (e) => {
			if (e.ctrlKey || e.metaKey) {
				if (e.key === "z") {
					e.preventDefault();
					if (e.shiftKey) {
						this.redo();
					} else {
						this.undo();
					}
				} else if (e.key === "y") {
					e.preventDefault();
					this.redo();
				}
			}
		});

		// Download image
		const downloadImageButton = document.getElementById("download-image");
		if (downloadImageButton) {
			downloadImageButton.addEventListener("click", () => {
				const image = this.getThumbnail("image");
				const url = URL.createObjectURL(image);
				const a = document.createElement("a");
				a.href = url;
				a.download = "oeee.png";
				a.click();
			});
		}

		// Download replay
		const downloadReplayButton = document.getElementById("download-replay");
		if (downloadReplayButton) {
			downloadReplayButton.addEventListener("click", () => {
				const replay = this.getThumbnail("animation");
				const url = URL.createObjectURL(replay);
				const a = document.createElement("a");
				a.href = url;
				a.download = "oeee.pch";
				a.click();
			});
		}

		// Color scheme selector
		const colorSchemeSelect = document.getElementById("color-scheme") as HTMLSelectElement;
		if (colorSchemeSelect) {
			colorSchemeSelect.addEventListener("change", () => {
				const newScheme = colorSchemeSelect.value as keyof typeof COLOR_SCHEMES;
				this.setColorScheme(newScheme);
			});
		}
	}

	private drawLine(fromX: number, fromY: number, toX: number, toY: number) {
		const points = [
			[fromX, fromY],
			[toX, toY],
		];
		const ctx = this.canvas.getContext("2d");
		if (!ctx) return;

		this.aerr = 0;

		this.draw(ctx, points, (left, top, buf8, imageData) => {
			this.bresenham(points, (x, y) => {
				this.setPoint(buf8, imageData.width, x, y, left, top);
			});
		});
		this.prevLine = points;
	}

	private bresenham(
		points: number[][],
		callback: (x0: number, y0: number) => void,
	) {
		let x0 = points[0][0];
		let y0 = points[0][1];
		const x1 = points[1][0];
		const y1 = points[1][1];

		const dx = Math.abs(x1 - x0);
		const sx = x0 < x1 ? 1 : -1;
		const dy = Math.abs(y1 - y0);
		const sy = y0 < y1 ? 1 : -1;
		let err = (dx > dy ? dx : -dy) / 2;

		while (true) {
			if (
				this.prevLine == null ||
				!(
					(this.prevLine[0][0] === x0 && this.prevLine[0][1] === y0) ||
					(this.prevLine[1][0] === x0 && this.prevLine[1][1] === y0)
				)
			) {
				callback(x0, y0);
			}

			if (x0 === x1 && y0 === y1) break;
			const e2 = err;
			if (e2 > -dx) {
				err -= dy;
				x0 += sx;
			}
			if (e2 < dy) {
				err += dx;
				y0 += sy;
			}
		}
		this.prevLine = points;
	}

	private setPoint(
		buf8: Uint8ClampedArray,
		bufWidth: number,
		x0: number,
		y0: number,
		left: number,
		top: number,
	) {
		const x = x0 - left;
		const y = y0 - top;

		this.setPenPoint(buf8, bufWidth, x, y);
	}

	private getAlpha(type: number): number {
		let a1 = this.penOpacity / 255.0;

		const ALPHATYPE_PEN = 1;
		const ALPHATYPE_FILL = 2;
		const ALPHATYPE_BRUSH = 3;

		switch (type) {
			case ALPHATYPE_PEN:
				if (a1 > 0.5) {
					a1 = 1.0 / 16 + ((a1 - 0.5) * 30.0) / 16;
				} else {
					a1 = Math.sqrt(2 * a1) / 16.0;
				}
				a1 = Math.min(1, Math.max(0, a1));
				break;

			case ALPHATYPE_FILL:
				a1 = -0.00056 * a1 + 0.0042 / (1.0 - a1) - 0.0042;
				a1 = Math.min(1.0, Math.max(0, a1 * 10));
				break;

			case ALPHATYPE_BRUSH:
				a1 = -0.00056 * a1 + 0.0042 / (1.0 - a1) - 0.0042;
				a1 = Math.min(1.0, Math.max(0, a1));
				break;
		}

		// When alpha is small, adjust visible density by skipping some points
		if (a1 < 1.0 / 255) {
			if (!this.aerr) this.aerr = 0;
			this.aerr += a1;
			a1 = 0;
			while (this.aerr > 1.0 / 255) {
				a1 = 1.0 / 255;
				this.aerr -= 1.0 / 255;
			}
		}
		return a1;
	}

	private setPenPoint(
		buf8: Uint8ClampedArray,
		width: number,
		x: number,
		y: number,
	) {
		const d = this.size;
		const r0 = Math.floor(d / 2);
		const adjustedX = x - r0;
		const adjustedY = y - r0;

		let index = (adjustedY * width + adjustedX) * 4;

		const shape = this._roundData[d];
		let shapeIndex = 0;

		const r1 = Number.parseInt(this.penColor.slice(1, 3), 16);
		const g1 = Number.parseInt(this.penColor.slice(3, 5), 16);
		const b1 = Number.parseInt(this.penColor.slice(5, 7), 16);

		const a1 = this.getAlpha(ALPHATYPE_PEN);
		if (a1 === 0) return;

		for (let i = 0; i < d; i++) {
			for (let j = 0; j < d; j++) {
				if (shape[shapeIndex++]) {
					const r0 = buf8[index + 0];
					const g0 = buf8[index + 1];
					const b0 = buf8[index + 2];
					const a0 = buf8[index + 3] / 255.0;

					let a = a0 + a1 - a0 * a1;
					let r = 0;
					let g = 0;
					let b = 0;
					if (a > 0) {
						const a1x = Math.max(a1, 1.0 / 255);

						r = (r1 * a1x + r0 * a0 * (1 - a1x)) / a;
						g = (g1 * a1x + g0 * a0 * (1 - a1x)) / a;
						b = (b1 * a1x + b0 * a0 * (1 - a1x)) / a;

						r = r1 > r0 ? Math.ceil(r) : Math.floor(r);
						g = g1 > g0 ? Math.ceil(g) : Math.floor(g);
						b = b1 > b0 ? Math.ceil(b) : Math.floor(b);
					}

					const tmp = a * 255;
					a = Math.ceil(tmp);

					buf8[index + 0] = r;
					buf8[index + 1] = g;
					buf8[index + 2] = b;
					buf8[index + 3] = a;
				}
				index += 4;
			}
			index += (width - d) * 4;
		}
	}

	private draw(
		ctx: CanvasRenderingContext2D,
		points: number[][],
		callback: (
			left: number,
			top: number,
			buf8: Uint8ClampedArray,
			imageData: ImageData,
		) => void,
	) {
		const xs = [];
		const ys = [];
		for (let i = 0; i < points.length; i++) {
			const point = points[i];
			xs.push(Math.round(point[0]));
			ys.push(Math.round(point[1]));
		}
		const xmin = Math.min.apply(null, xs);
		const xmax = Math.max.apply(null, xs);
		const ymin = Math.min.apply(null, ys);
		const ymax = Math.max.apply(null, ys);

		const r = Math.ceil(this.size / 2);
		const left = xmin - r;
		const top = ymin - r;
		const width = xmax - xmin;
		const height = ymax - ymin;

		const imageData = ctx.getImageData(
			left,
			top,
			width + r * 2,
			height + r * 2,
		);
		const buf8 = new Uint8ClampedArray(imageData.data.buffer);

		callback(left, top, buf8, imageData);

		imageData.data.set(buf8);
		ctx.putImageData(imageData, left, top);
	}

	private getCoordinates(event: MouseEvent | TouchEvent | PointerEvent): {
		x: number;
		y: number;
	} {
		const rect = this.canvas.getBoundingClientRect();
		const clientX = (event as MouseEvent | PointerEvent).clientX;
		const clientY = (event as MouseEvent | PointerEvent).clientY;

		return {
			x: clientX - rect.left,
			y: clientY - rect.top,
		};
	}

	private _pushUndo() {
		const ctx = this.canvas.getContext("2d");
		if (ctx) {
			// Store current state as last state
			this.lastState = ctx.getImageData(
				0,
				0,
				this.canvas.width,
				this.canvas.height,
			);
			// Clear redo state when new action is performed
			this.redoState = null;
		}
	}

	private undo() {
		if (this.lastState) {
			const ctx = this.canvas.getContext("2d");
			if (ctx) {
				// Save current state and items as redo state
				this.redoState = ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
				this.redoItems = [...this.items];

				// Restore last state and items
				ctx.putImageData(this.lastState, 0, 0);
				if (this.lastItems) {
					this.items = [...this.lastItems];
					this.head = this.items.length - 1;
				}

				// Clear last state
				this.lastState = null;
				this.lastItems = null;
			}
		}
	}

	private redo() {
		if (this.redoState) {
			const ctx = this.canvas.getContext("2d");
			if (ctx) {
				// Save current state and items as last state
				this.lastState = ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
				this.lastItems = [...this.items];

				// Restore redo state and items
				ctx.putImageData(this.redoState, 0, 0);
				if (this.redoItems) {
					this.items = [...this.redoItems];
					this.head = this.items.length - 1;
				}

				// Clear redo state
				this.redoState = null;
				this.redoItems = null;
			}
		}
	}

	private handleStart(event: MouseEvent | TouchEvent | PointerEvent) {
		event.preventDefault();

		// Only start drawing on primary button (left click) or touch
		if ((event as MouseEvent).button === 0 || event.type === 'touchstart') {
			this.isDrawing = true;
			this._updateMousePosition(event);
			this.prevMouseX = this.mouseX;
			this.prevMouseY = this.mouseY;

			// Push undo state first
			this._pushUndo();

			const coords = this.getCoordinates(event);
			const x = Math.floor(coords.x);
			const y = Math.floor(coords.y);
			const red = Number.parseInt(this.penColor.slice(1, 3), 16);
			const green = Number.parseInt(this.penColor.slice(3, 5), 16);
			const blue = Number.parseInt(this.penColor.slice(5, 7), 16);
			const alpha = 255;

			this.lastX = x;
			this.lastY = y;

			// Draw a point at the click location
			this.drawLine(x, y, x, y);

			// Record the stroke start in items array
			this.items[this.head].push(
				"freeHand",
				0,
				red,
				green,
				blue,
				alpha,
				0,
				0,
				0,
				this.size,
				0,
				LINETYPE_PEN,
			);

			this.items[this.head].push(x, y, x, y);
		}
	}

	private handleMove(event: MouseEvent | TouchEvent | PointerEvent) {
		event.preventDefault();

		this._updateMousePosition(event);
		if (this.isDrawing) {
			const coords = this.getCoordinates(event);
			const x = Math.floor(coords.x);
			const y = Math.floor(coords.y);
			const prevX = Math.floor(this.lastX);
			const prevY = Math.floor(this.lastY);

			this.drawLine(x, y, prevX, prevY);
			this.lastX = x;
			this.lastY = y;

			this.items[this.head].push(x, y);
		}

		this.prevMouseX = this.mouseX;
		this.prevMouseY = this.mouseY;
	}

	private handleEnd(event: MouseEvent | TouchEvent | PointerEvent) {
		event.preventDefault();
		if (this.isDrawing) {
			this.isDrawing = false;

			this.head++;
			this.items.push([]);
		}
	}

	private setColorScheme(scheme: keyof typeof COLOR_SCHEMES) {
		// Confirm color scheme change
		if (!confirm("Changing color scheme will clear the canvas. Continue?")) {
			return;
		}

		this.colorScheme = scheme;
		this.penColor = COLOR_SCHEMES[this.colorScheme].pen;
		const fillColorHex = COLOR_SCHEMES[this.colorScheme].fill;

		// Update the color picker previews and select pen color by default
		const preview1 = document.getElementById("color-picker-option-1-preview");
		const preview2 = document.getElementById("color-picker-option-2-preview");
		const penRadio = document.querySelector('input[id="color-picker-option-1"][value="color-picker"]') as HTMLInputElement;

		if (preview1) preview1.style.backgroundColor = this.penColor;
		if (preview2) preview2.style.backgroundColor = fillColorHex;
		if (penRadio) penRadio.checked = true;

		// Store current state for undo
		this._pushUndo();

		// Flood fill with new background color
		const ctx = this.canvas.getContext("2d");
		if (ctx) {
			ctx.fillStyle = fillColorHex;
			ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
		}

		this.head = 0;
		this.items = [[]];
		this.items[this.head] = [
			"floodFill",
			0, // layer
			0, // x
			0, // y
			this.hexToInt(fillColorHex), // Using shared method
		];
		this.head++;
		this.items.push([]);
	}
}

const container = document.getElementById("oeee");
if (container) {
	new Oeee(container);
}
