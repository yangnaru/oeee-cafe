import { compressToUint8Array } from "lz-string";

const ALPHATYPE_PEN = 1;

const REPLAY_LINETYPE_PEN = 1;

const REPLAY_PEN_TYPE_FLOODFILL = "floodFill" as const;
const REPLAY_PEN_TYPE_FREEHAND = "freeHand" as const;
const REPLAY_PEN_TYPE_RESTORE = "restore" as const;

type PenType = "floodFill" | "freeHand" | "restore";

type EmptyArray = [];

type FloodFillElements = [
	PenType, // REPLAY_PEN_TYPE_FLOODFILL,
	number, // layer
	number, // x
	number, // y
	number, // color
]

type FreeHandCoordinates = [
	number, // x
	number, // y
]

type FreeHandElements = [
	PenType, // REPLAY_PEN_TYPE_FREEHAND,
	number, // layer
	number, // red
	number, // green
	number, // blue
	number, // alpha
	number, // 0
	number, // 0
	number, // 0
	number, // pen size
	number, // 0
	number, // REPLAY_LINETYPE_PEN

	// Any number or FreeHandCoordinates
	...FreeHandCoordinates[]
]

type RestoreElements = [
	PenType, // REPLAY_PEN_TYPE_RESTORE,
	string, // layer 0 (image data)
	string, // layer 1 (empty canvas data, for now)
]

type Replay = (EmptyArray | FloodFillElements | FreeHandElements | RestoreElements)[]

export default class Cucumber {
	private initializedAt: number;

	private canvas: HTMLCanvasElement;
	private penSize = 0;
	private penColor = "#000000";
	private penOpacity = 255;
	private isDrawing = false;
	private lastX = 0;
	private lastY = 0;
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

	private items: Replay = [];
	private head = 0;

	private lastState: ImageData | null = null; // Store only last state

	constructor(
		container: HTMLElement,
		options: {
			width: number;
			height: number;
			penSize: number;
			backgroundColor: string;
			foregroundColor: string;
		}
	) {
		this.initializedAt = Date.now();
		this._initRoundData();

		this.penSize = options.penSize;
		this.penColor = options.foregroundColor;

		this.canvas = document.createElement("canvas");
		this.canvas.id = "cucumber-canvas";
		this.canvas.width = options.width;
		this.canvas.height = options.height;
		this.canvas.style.imageRendering = "pixelated";
		container.appendChild(this.canvas);

		// Flood canvas with the color scheme's fill color
		const ctx = this.canvas.getContext("2d");
		if (ctx) {
			ctx.fillStyle = options.backgroundColor;
			ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
		}

		this.items = [
			[
				REPLAY_PEN_TYPE_FLOODFILL,
				0, // layer
				0, // x
				0, // y
				this.hexToInt(options.backgroundColor), // Using shared method
			] as FloodFillElements,
		];
		this.head++;
		this.items.push([]);

		container.addEventListener("pointerdown", this.handleStart.bind(this));
		container.addEventListener("touchstart", this.handleStart.bind(this));
		container.addEventListener("mousedown", this.handleStart.bind(this));

		container.addEventListener("pointermove", this.handleMove.bind(this));
		container.addEventListener("touchmove", this.handleMove.bind(this));
		container.addEventListener("mousemove", this.handleMove.bind(this));

		container.addEventListener("pointerup", this.handleEnd.bind(this));
		container.addEventListener("pointercancel", this.handleEnd.bind(this));
		container.addEventListener("touchend", this.handleEnd.bind(this));
		container.addEventListener("touchcancel", this.handleEnd.bind(this));
		container.addEventListener("mouseup", this.handleEnd.bind(this));
	}

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

	getInitializedAt() {
		return this.initializedAt;
	}

	getCanvas() {
		return this.canvas;
	}

	getStrokeCount() {
		return this.items.length;
	}

	getReplay(): Blob {
		// Create a copy of items and remove the last empty array
		const itemsToExport = [...this.items];
		if (
			itemsToExport.length > 0 &&
			Array.isArray(itemsToExport[itemsToExport.length - 1]) &&
			itemsToExport[itemsToExport.length - 1].length === 0
		) {
			itemsToExport.pop();
		}

		const magic = "NEO ";
		const w = this.canvas.width;
		const h = this.canvas.height;

		const emptyCanvas = document.createElement("canvas");
		emptyCanvas.width = w;
		emptyCanvas.height = h;

		const restoreData: RestoreElements = [
			REPLAY_PEN_TYPE_RESTORE,
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

	// Add the shared hexToInt method
	private hexToInt(hex: string): number {
		const r = Number.parseInt(hex.slice(1, 3), 16);
		const g = Number.parseInt(hex.slice(3, 5), 16);
		const b = Number.parseInt(hex.slice(5, 7), 16);
		// Use alpha = 255 (fully opaque)
		return (255 << 24) | (b << 16) | (g << 8) | r; // ABGR format
	}

	private _updateMousePosition(e: MouseEvent | TouchEvent | PointerEvent) {
		const rect = this.canvas.getBoundingClientRect();
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

	setPenColor(color: string) {
		this.penColor = color;

		if (this.isDrawing) {
			this.isDrawing = false;

			this.head++;
			this.items.push([]);
		}
	}

	setPenSize(size: number) {
		this.penSize = size;

		if (this.isDrawing) {
			this.isDrawing = false;

			this.head++;
			this.items.push([]);
		}
	}

	undo() {
		if (this.head > 1) { // Floodfill is first item, not undoable
			this.head--;
			this.items.pop();
			this.items[this.head] = [];
		}

		if (this.lastState) {
			const ctx = this.canvas.getContext("2d");
			if (ctx) {
				ctx.putImageData(this.lastState, 0, 0);
			}
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
		callback: (x0: number, y0: number) => void
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
		top: number
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
		y: number
	) {
		const d = this.penSize;
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
			imageData: ImageData
		) => void
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

		const r = Math.ceil(this.penSize / 2);
		const left = xmin - r;
		const top = ymin - r;
		const width = xmax - xmin;
		const height = ymax - ymin;

		const imageData = ctx.getImageData(
			left,
			top,
			width + r * 2,
			height + r * 2
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

		let clientX: number;
		let clientY: number;

		if (typeof TouchEvent !== "undefined" && event instanceof TouchEvent) {
			clientX = event.touches[0].clientX;
			clientY = event.touches[0].clientY;
		} else {
			clientX = (event as MouseEvent | PointerEvent).clientX;
			clientY = (event as MouseEvent | PointerEvent).clientY;
		}

		return {
			x: clientX - rect.left,
			y: clientY - rect.top,
		};
	}

	// Event types that are allowed to draw on canvas:
	// - MouseEvent (draw with mouse)
	// - PointerEvent (draw with pen, not touch)
	private shouldIgnoreTouchEvent(
		event: MouseEvent | TouchEvent | PointerEvent
	): boolean {
		// Ignore touch events
		if (typeof TouchEvent !== "undefined" && event instanceof TouchEvent) {
			return true
		}

		// Ignore pointer events with pointerType "touch"
		if (event instanceof PointerEvent && event.pointerType === "touch") {
			return true;
		}

		return false
	}

	private handleStart(event: MouseEvent | TouchEvent | PointerEvent) {
		event.preventDefault();

		// Ignore if already drawing
		if (this.isDrawing) return;

		// Check if this is a touch event that should be ignored
		if (this.shouldIgnoreTouchEvent(event)) return;

		// Only start drawing on primary button (left click)
		if ((event as MouseEvent).button === 0) {
			// Store undo state first
			const ctx = this.canvas.getContext("2d");
			if (ctx) {
				this.lastState = ctx.getImageData(
					0,
					0,
					this.canvas.width,
					this.canvas.height
				);
			}

			this.isDrawing = true;
			this._updateMousePosition(event);
			this.prevMouseX = this.mouseX;
			this.prevMouseY = this.mouseY;

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
			const currentItem = this.items[this.head];
			if (!currentItem.length) {
				// Type assertion to ensure currentItem is initially empty
				if ((currentItem as EmptyArray).length !== 0) {
					throw new Error("Expected empty array");
				}
				(currentItem as FreeHandElements).push(
					REPLAY_PEN_TYPE_FREEHAND,
					0,
					red,
					green,
					blue,
					alpha,
					0,
					0,
					0,
					this.penSize,
					0,
					REPLAY_LINETYPE_PEN,
					x,
					y,
					x,
					y
				);
			}
		}
	}

	private handleMove(event: MouseEvent | TouchEvent | PointerEvent) {
		event.preventDefault();

		// Check if this is a touch event that should be ignored
		if (this.shouldIgnoreTouchEvent(event)) return;

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

			const currentItem = this.items[this.head];
			if (currentItem[0] === REPLAY_PEN_TYPE_FREEHAND) {
				(currentItem as FreeHandElements).push(x, y);
			}
		}

		this.prevMouseX = this.mouseX;
		this.prevMouseY = this.mouseY;
	}

	private handleEnd(event: MouseEvent | TouchEvent | PointerEvent) {
		event.preventDefault();

		// Check if this is a touch event that should be ignored
		if (this.shouldIgnoreTouchEvent(event)) return;

		if (this.isDrawing) {
			this.isDrawing = false;

			this.head++;
			this.items.push([]);
		}
	}
}
