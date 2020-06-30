// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.
import * as RandExp from "randexp";
import * as randomWords from "random-words";
import _ from "lodash";

import { IGenerator, FieldFormat, FieldType, ILabel, IGeneratorTagInfo } from "../../../../models/applicationState";
import { randomIntInRange } from "../../../../common/utils";

// Debugging controls
const DO_JITTER = true;
const USE_RANDOM_WORDS = true;

export interface IGeneratedInfo {
    name: string,
    text: string,
    boundingBoxes: GeneratedBboxInfo,
    format: GeneratorTextStyle,
    page: number,
}
interface WordLevelBbox {
    boundingBox: number[],
    boundingBoxPercentage: number[],
    text: string
}

interface GeneratedBboxInfo {
    full: number[], // drawn
    lines: OCRLine[], // taut to words, line bbox
    words: WordLevelBbox[], // bbox for each word
}

interface OCRWord {
    boundingBox: number[],
    text: string,
    confidence: number,
}

export interface OCRLine {
    boundingBox: number[],
    text: string,
    words: OCRWord[]
}

export interface GeneratorTextStyle {
    text: string,
    fontWeight: number,
    fontSize: string, // e.g. 14px
    lineHeight: number,
    fontFamily: string, // e.g. sans-serif
    align: string,
    baseline: string,
    offsetX: number,
    offsetY: number, // returned with down = positive
    placement: any,
    maxAngle: any,
    overflow: any,
    rotation: number,
    fill: any,
    outlineColor: any,
    outlineWidth: number,
}

// Top of text generates at center
// Note this is only for rendered text - the actual OCR generation is separate, but should align with this
const defaultStyle: GeneratorTextStyle = {
    text: "SAMPLE",
    fontWeight: 100,
    fontSize: '14px',
    lineHeight: 1,
    fontFamily: 'sans-serif',
    align: "left",
    baseline: "top", // kinda arbitrary reference but easier to think about
    offsetX: 0,
    offsetY: 0,
    placement: "point",
    maxAngle: undefined,
    overflow: "true",
    rotation: 0,
    fill: "#000",
    outlineColor: "#E00",
    outlineWidth: 0,
};

// TODO expose these in control panel
const GEN_CONSTANTS = {
    weight: 100,
    weightJitter: 25,
    lineHeight: 1,
    lineHeightJitter: .3,
    widthScale: 1,
    widthScaleJitter: .05,
    heightScale: 1,
    heightScaleJitter: .05,
    // https://stackoverflow.com/questions/14061228/remove-white-space-above-and-below-large-text-in-an-inline-block-element
    leadingLineHeightScale: 1.35, // account for the font-to-full height discrepancy with our default font
    sizeJitter: 1,
    offsetX: .1,
    offsetXJitter: .2,
    offsetY: .03,
    offsetYJitter: .03,
    // Char limits
    // TODO better than linear lower bound (super long fields shouldn't have multiple)
    width_low: 0.3,
    width_high: 1.05,
    height_low: 0.2,
    height_high: 0.9, // try not to bleed past the box due to scaling inaccs
    sizing_samples: 12, // sample count for line sampling
    sizing_string: 'abcdefghiklmnorstuvwxzABCDEFGHIJKLMNOPQRSTUVWXYZ', // we drop the baselines so we can be a little bigger
    sizing_range: [10, 100] // search range for font sizing
}

// the generation step formatting should be done when calibrating the text to display
interface LimitsAndFormat {
    format: Partial<GeneratorTextStyle>,
    // should include as much as possible
    limits: number[][]
}

// TODO seeding
// TODO add conversion step for rendering
// TODO scale constants appropriately
export const generate:(g: IGenerator, ocr: any, resolution?: any) => IGeneratedInfo = (generator, ocr, resolution=1) => {
    /**
     * Generation step - provides all generation info. From generator + context (ocr) to generated data.
     * generator: Generator region
     * ocr: ocr read results
     */
    // This still isn't pixel perfect, I can't figure out how OL does the font size calculations internally (just a workaround atm)
    // But actually this is a magic number designed to match css pixels to image units
    // There's no way to actually deal with this because we have no API to measure ^
    const adjustedResolution = 1/66; // resolution * 1.2;
    // Make smaller to make font size smaller
     // Calculate a sizing first pass
    const ocrUnitsPerChar = getOcrUnitsPerChar(generator, ocr);

    // Translate to rough character bounds and format
    const limitsAndFormat = getStringLimitsAndFormat(generator, ocrUnitsPerChar, ocr, adjustedResolution);
    // Generate string from bounds
    const text = generateString(generator, limitsAndFormat.limits);
    const format = { ...defaultStyle, ...limitsAndFormat.format, text };
    // Translate string into precise OCR boxes
    const boundingBoxes = generateBoundingBoxes(generator, format, ocr, ocrUnitsPerChar, adjustedResolution);
    // If we wanted to be more careful about existing characters, we'd need to merge the last two steps
    return {
        name: generator.tag.name,
        text,
        boundingBoxes,
        format,
        page: generator.page,
    };
}


const getOcrUnitsPerChar: (g: IGenerator, ocr: any) => number[] = (generator, ocr) => {
    // "font size" approximated by the median font size of the document
    // can probably be elaborated, i.e. font long strings of text or closest form elements...
    const sampledLines = [];
    if (!("ocrLine" in generator) || generator.ocrLine === -1) {
        for (let i = 0; i < GEN_CONSTANTS.sizing_samples; i++) {
            sampledLines.push(ocr.lines[randomIntInRange(0, ocr.lines.length)]);
        }
    } else {
        sampledLines.push(ocr.lines[generator.ocrLine]);
    }
    const sampledNestedWords = sampledLines.map(l => l.words);
    const sampledWords = [].concat.apply([], sampledNestedWords);
    const widths = [];
    const heights = [];
    sampledWords.forEach(w => {
        widths.push((w.boundingBox[2] - w.boundingBox[0]) / w.text.length);
        heights.push((w.boundingBox[5] - w.boundingBox[1]));
    });

    // - scale to map units, which we can convert to pixels
    const widthPerChar = median(widths);
    const heightPerChar = median(heights);
    const scaledWidth = widthPerChar * GEN_CONSTANTS.widthScale * (1 + jitter(GEN_CONSTANTS.widthScaleJitter));
    const scaledHeight = heightPerChar * GEN_CONSTANTS.heightScale * (1 + jitter(GEN_CONSTANTS.heightScaleJitter));
    return [ scaledWidth, scaledHeight ];
}

const median: (a: number[]) => number = (rawArray) => {
    const array = rawArray.sort();
    if (array.length % 2 === 0) { // array with even number elements
        return (array[array.length/2] + array[(array.length / 2) - 1]) / 2;
    }
    else {
        return array[(array.length - 1) / 2]; // array with odd number elements
    }
};

/**
 * Define bounding boxes for a given sampled format on a generator.
 * @param generator generator information
 * @param format sampled format
 * @param ocr ocr read results for page
 * @param unitsPerChar ocr units per character
 * @param resolution scaling magic number
 */
const generateBoundingBoxes: (g: IGenerator, format: GeneratorTextStyle, ocr: any, unitsPerChar: number[], resolution?: number) => GeneratedBboxInfo =
    (generator, format, ocr, unitsPerChar, resolution=1) => {
    const text = format.text;
    const full = generator.bbox;
    const center = [(full[0] + full[2]) / 2, (full[1] + full[5]) / 2];
    const offsetX = format.offsetX;
    const offsetY = format.offsetY; // center + map offset y should get y of top box
    // negative due to map -> image/canvas inversion
    // doing center displacement to match rendering flow

    // For true text metrics, we can measure mapWidth, but we can't measure height. (Without div hack)
    // We can use the same heuristic used to calculate font format
    const [ widthPerChar, heightPerChar ] = unitsPerChar;

    // track all words (for labels)
    let words: WordLevelBbox[] = [];
    const lines: OCRLine[] = [];
    const lineStrings = text.split("\n");
    let textOffsetY = 0;
    lineStrings.forEach(lineString => {
        const wordStrings = lineString.split(" ");
        let accumulatedString = "";
        const lineWords: WordLevelBbox[] = [];
        wordStrings.forEach(wordString => {
            // Calculate current word base offset (in pixels)
            const withoutMetrics = getTextMetrics(accumulatedString, styleToFont(format));
            accumulatedString += wordString + " ";
            const wordMetrics = getTextMetrics(wordString, styleToFont(format));
            // resolution is map units per pixel
            const textOffsetX = withoutMetrics.width * resolution;
            const imageWordWidth = wordMetrics.width * resolution;
            // measure again since it's a diff word than the standard string
            const imageWordHeight = (wordMetrics.actualBoundingBoxAscent + wordMetrics.actualBoundingBoxDescent) * resolution;
            // Align top is alignment with top of font (rendering obeys font baseilene)
            // Thus, if we're short (as indicated by measured height), we'll need to offset by the difference
            const alignmentMeasure = getTextMetrics("M", styleToFont(format));
            const alignmentHeight =  (alignmentMeasure.actualBoundingBoxAscent - wordMetrics.actualBoundingBoxAscent) * resolution;

            const imageOffsetX = offsetX + textOffsetX;
            const imageOffsetY = offsetY + textOffsetY + alignmentHeight;

            // * start from bbox TOP LEFT (smallest coords)
            // since origin is TL, TL does not include the word height, we include it as we go down
            const wordTl = [
                center[0] + imageOffsetX,
                center[1] + imageOffsetY
            ];
            const wordTr = [
                center[0] + imageOffsetX + imageWordWidth,
                center[1] + imageOffsetY
            ];
            const wordBr = [
                center[0] + imageOffsetX + imageWordWidth,
                center[1] + imageOffsetY + imageWordHeight];
            const wordBl = [
                center[0] + imageOffsetX,
                center[1] + imageOffsetY + imageWordHeight
            ];

            const boundingBox = [].concat.apply([], [wordTl, wordTr, wordBr, wordBl]);;
            const boundingBoxPercentage = boundingBox.map((el, index) => {
                if (index % 2 === 0) {
                    return el / ocr.width;
                }
                return el / ocr.height;
            });

            lineWords.push({
                boundingBox,
                boundingBoxPercentage,
                text: wordString,
            });
        });

        textOffsetY += heightPerChar * format.lineHeight * GEN_CONSTANTS.leadingLineHeightScale;

        // get line extent from first and last words
        const tl = lineWords[0].boundingBox.slice(0, 2);
        const br = lineWords.slice(-1)[0].boundingBox.slice(4, 6);
        const lineBBox = [
            tl[0], tl[1],
            br[0], tl[1],
            br[0], br[1],
            tl[0], br[1],
        ];
        words = words.concat(lineWords);
        lines.push({
            boundingBox: lineBBox,
            text: lineString,
            words: lineWords.map(completeOCRWord),
        });
    });

    return {
        full,
        lines,
        words
    };
}


const generateString: (g: IGenerator, l: number[][]) => string = (generator, limits) => {
    const [ widthLimit, heightLimit ] = limits;
    const [ low, high ] = widthLimit;
    const [ heightLow, heightHigh ] = heightLimit;
    const linesUsed = randomIntInRange(heightLow, heightHigh);

    const defaultRegex = `^.{${low},${high}}$`;
    const dd = "(0[1-9]|[12][0-9]|3[01])";
    const mm = "(0[1-9]|1[012])";
    const yy = "(19|20)\\d\\d";
    const regexDict = {
        [FieldType.String]: {
            [FieldFormat.NotSpecified]: defaultRegex,
            [FieldFormat.Alphanumeric]: `^[a-zA-Z ]{${low},${high}}$`,
            // [FieldFormat.Alphanumeric]: `^[a-zA-Z0-9 ]{${low},${high}}$`,
            [FieldFormat.NoWhiteSpaces]: `^[a-zA-Z0-9]{${low},${high}}$`,
        },
        [FieldType.Number]: {
            [FieldFormat.NotSpecified]: `^\\d{${low},${high}}$`,
            [FieldFormat.Currency]: `^\\$?((([1-9][0-9]){1,2},){${Math.round(low/5)},${Math.round(high/5)}}[0-9]{3}|[0-9]{${low},${high}})(\\.[0-9][0-9])?$`,
        },
        [FieldType.Date]: {
            [FieldFormat.NotSpecified]: `^\\d\\d([- /.])\\d\\d\\1\\d{2,4}$
            `,
            [FieldFormat.DMY]: `^${dd}([- /.])${mm}\\2${yy}$`,
            [FieldFormat.MDY]: `^${mm}([- /.])${dd}\\2${yy}$`,
            [FieldFormat.YMD]: `^${yy}([- /.])${mm}\\2${dd}$`,
        },
        [FieldType.Time]: {
            [FieldFormat.NotSpecified]: "^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$",
        },
        [FieldType.Integer]: {
            [FieldFormat.NotSpecified]: `^\\d{${low},${high}}$`,
        },
        [FieldType.SelectionMark]: {
            // no support
        },
    }

    const fieldType = generator.tag.type;
    const fieldFormat = generator.tag.format;
    let instanceGenerator = () => {
        let regex = regexDict[FieldType.String][FieldFormat.NotSpecified];
        if (fieldType in regexDict && fieldFormat in regexDict[fieldType]) {
            regex = regexDict[fieldType][fieldFormat];
        }
        // @ts-ignore - something is messed up with this import, satisfying it in lint breaks on runtime
        const randexp = new RandExp(regex);
        return randexp.gen();
    }

    if (USE_RANDOM_WORDS && fieldType === FieldType.String && fieldFormat === FieldFormat.Alphanumeric) {
        instanceGenerator = () => {
            // low, high
            const maxLength = high;
            const formatter = (word, index)=> {
                return Math.random() < 0.3 ? word.slice(0,1).toUpperCase().concat(word.slice(1)) : word;
            }
            return randomWords({
                min: Math.max(Math.round(low / maxLength), 1),
                max: Math.round(high / maxLength),
                maxLength,
                minLength: 6,
                join: " ",
                formatter,
            });
        };
    }

    const lineStrings = [];
    // Best effort for multiline atm - just do multiple newlines
    for (let i = 0; i < linesUsed; i++) {
        lineStrings.push(instanceGenerator());
    }
    return lineStrings.join("\n");
}

/**
 * Returns string limits as determined by absolute units, and format, as determined by current canvas resolution
 * @param generator generator to use
 * @param unitsPerChar absolute scaling in OCR units
 * @param ocr used as reference for font sizing
 * @param resolution current canvas resolution (omitted on training gen)
 */
const getStringLimitsAndFormat: (g: IGenerator, unitsPerChar: number[], ocr: any, resolution?: number) => LimitsAndFormat =
    (generator, unitsPerChar, ocr, resolution = 1) => {
    const fontWeight = GEN_CONSTANTS.weight + jitter(GEN_CONSTANTS.weightJitter, true);
    const lineHeight = GEN_CONSTANTS.lineHeight + jitter(GEN_CONSTANTS.lineHeightJitter, true);

    // Map Units to Font size - Search for the right size by measuring canvas
    const [ widthPerChar, heightPerChar ] = unitsPerChar;

    const boxWidth = generator.bbox[2] - generator.bbox[0];
    const boxHeight = generator.bbox[5] - generator.bbox[1];
    const effectiveLineHeight = heightPerChar * lineHeight * GEN_CONSTANTS.leadingLineHeightScale;

    const charWidthLow = Math.round(boxWidth * GEN_CONSTANTS.width_low / widthPerChar);
    const charWidthHigh = Math.round(boxWidth * GEN_CONSTANTS.width_high / widthPerChar);
    const charHeightLow = Math.max(1, Math.round(boxHeight * GEN_CONSTANTS.height_low / effectiveLineHeight));
    let charHeightHigh = Math.round(boxHeight * GEN_CONSTANTS.height_high / effectiveLineHeight);

    // Using height since that's more important for visual fit
    let bestSize = GEN_CONSTANTS.sizing_range[0];
    let bestDistance = 1000;
    let curSize = bestSize;
    // ! The target pixel height shouldn't change wrt the zoom the generator was created at
    // So - map units correspond in a fixed way with OCR, which is good
    // We introduce pixels because we need it to measure rendered text to calculate bboxes and size things (actually just for the preview)
    // The pixel metrics of the text we measure is on an arbitrary canvas
    // But pixels are constant across canvases, so it's effectively the pixel metrics on our canvas
    // Which we can validate as the proper pixel metrics we expect given current resolution
    // But pixels AREN'T constant across canvases,
    // As on this canvas, font size doesn't have a fixed pixel height!
    // So the actual conversion from pixels to image units is arbitrary,
    // but the important bit is that it's consistent between when we set it
    // we'll probably need to add an adjustment factor for different screens
    // TODO deal with this ^
    // and when we use it for measuring boxes later
    // This is all captured in the resolution factor
    const targetPixelHeight = heightPerChar / resolution;
    while (curSize < GEN_CONSTANTS.sizing_range[1]) {
        const font = `${fontWeight} ${curSize}px/${lineHeight} sans-serif`;
        const sizingString = ("ocrLine" in generator && generator.ocrLine !== -1) ?
            ocr.lines[generator.ocrLine].text : GEN_CONSTANTS.sizing_string;
        const metrics = getTextMetrics(sizingString, font);
        const newHeight = metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent;
        const newDistance = Math.abs(newHeight - targetPixelHeight);
        if (newDistance <= bestDistance) {
            bestDistance = newDistance;
            bestSize = curSize;
            curSize += 1;
            // linear search best search
        } else {
            break;
        }
    }

    const fontSize = `${bestSize + jitter(GEN_CONSTANTS.sizeJitter)}px`;

    // Positioning - offset is in OCR Units

    const centerWidth = (generator.bbox[2] + generator.bbox[0]) / 2;
    const left = generator.bbox[0];
    const centerHeight = (generator.bbox[1] + generator.bbox[5]) / 2;
    const top = generator.bbox[1];
    const offsetX = (left - centerWidth + GEN_CONSTANTS.offsetX + jitter(GEN_CONSTANTS.offsetXJitter));

    // OffsetY - passively represents positive distance from top to center (positive due to map coords)
    // Thus if you add it, you move your point from the center to the top
    let offsetY = (top - centerHeight + GEN_CONSTANTS.offsetY + jitter(GEN_CONSTANTS.offsetYJitter));

    if (generator.tag.type !== FieldType.String) {
        // center text if not string (no multiline non-string assumption)
        offsetY = (heightPerChar / 2 + GEN_CONSTANTS.offsetY + charHeightHigh * jitter(GEN_CONSTANTS.offsetYJitter));
        charHeightHigh = 2;
    }

    return {
        limits: [[charWidthLow, charWidthHigh], [charHeightLow, charHeightHigh]],
        format: {
            fontSize,
            fontWeight,
            lineHeight,
            offsetX,
            offsetY,
        },
    };
}

const jitter = (max: number, round: boolean = false) => {
    if (!DO_JITTER) return 0;
    const val = (Math.random() * 2 - 1) * max;
    return round ? Math.round(val) : val;
}

export const styleToFont = (style: GeneratorTextStyle) => `${style.fontWeight} ${style.fontSize}/${style.lineHeight} ${style.fontFamily}`;

const getTextMetrics = (text, font) => {
    // re-use canvas object for better performance
    const canvas = document.createElement("canvas");
    // const canvas = this.getTextWidth.canvas || (this.getTextWidth.canvas = document.createElement("canvas"));
    const context = canvas.getContext("2d");
    context.font = font;
    const metrics = context.measureText(text)
    return metrics;
}

export const generatorInfoToOCRLines: (g: IGeneratedInfo) => OCRLine[] = (generatedInfo) => {
    return generatedInfo.boundingBoxes.lines;
}

const completeOCRWord: (wordInfo: any) => OCRWord = (wordInfo) => {
    return {
        boundingBox: wordInfo.boundingBox,
        text: wordInfo.text,
        confidence: 1.0
    };
}

export const generatorInfoToLabel: (g: IGeneratedInfo) => ILabel = (generatedInfo) => {
    return {
        label: generatedInfo.name,
        key: null,
        value: generatedInfo.boundingBoxes.words.map(w => ({
                page: generatedInfo.page,
                text: w.text,
                boundingBoxes: [w.boundingBoxPercentage],
        }))
    };
}

export const matchBboxToOcr: (bbox: number[], pageOcr: any) => IGeneratorTagInfo = (bbox, pageOcr) => {
    const numberFlags = ["#", "number", "num.", "phone", "amount"];

    let name = "";
    let type = FieldType.String;
    let format = FieldFormat.Alphanumeric;
    let ocrLine = -1;
    // A few quality of life heuristics
    if (pageOcr) {
        // Find the closest text
        let closestDist = 1; // at most half an inch away
        const refLoc = [bbox[0], bbox[1]];
        const ocrRead = pageOcr;
        ocrRead.lines.forEach((line, index) => {
            line.words.forEach(word => {
                const loc = [word.boundingBox[0], word.boundingBox[1]]; // TL
                const dist = Math.hypot(loc[0] - refLoc[0], loc[1] - refLoc[1]);
                if (dist < closestDist) {
                    // TODO add a check for box is contained, which trumps TL
                    if (line.text.length > 20) {
                        name = _.camelCase(word.text);
                    } else {
                        name = _.camelCase(line.text);
                    }

                    if (numberFlags.some(flag => line.text.toLowerCase().includes(flag))) {
                        type = FieldType.Number;
                        format = FieldFormat.NotSpecified;
                    } else {
                        type = FieldType.String;
                        format = FieldFormat.Alphanumeric;
                    }
                    closestDist = dist;
                    // Also, capture the line on the generator so we can match statistics
                    // do this here rather than on generation for convenience
                    ocrLine = index;
                }
            });
        });
    };

    const tagProposal = { name, type, format };
    return { tagProposal, ocrLine };
}


// Bbox utils
/**
 * Returns whether box1 center is in box2
 * @param box1 contained box
 * @param box2 containing box
 */
export const isBoxCenterInBbox = (box1: number[], box2: number[]) => {
    const centerX = (box1[0] + box1[2]) / 2;
    const centerY = (box1[1] + box1[5]) / 2;
    return centerX > box2[0] && centerX < box2[2] && centerY > box2[1] && centerY < box2[5];
}

export const fuzzyScaledBboxEqual = (ocrReadResults: any, labelBox: number[], ocrBox: number[]) => {
    const ocrBoxScaled = ocrBox.map((coord, i) => i % 2 === 0 ? coord / ocrReadResults.width : coord / ocrReadResults.height);
    return ocrBoxScaled.every((coord, i) => Math.abs(coord - labelBox[i]) < 0.01);
}

export const unionBbox = (boxes: number[][]) => {
    const boxXCoords = boxes.map(b => b.filter((_, i) => i % 2 === 0));
    const boxYCoords = boxes.map(b => b.filter((_, i) => i % 2 === 1));
    const flatXCoords = [].concat.apply([], boxXCoords);
    const flatYCoords = [].concat.apply([], boxYCoords);
    const minX = Math.min(...flatXCoords);
    const maxX = Math.max(...flatXCoords);
    const minY = Math.min(...flatYCoords);
    const maxY = Math.max(...flatYCoords);
    return [minX, minY, maxX, minY, maxX, maxY, minX, maxY];
}

export const padBbox = (bbox: number[], xRatio, yRatio) => {
    let x1 = bbox[0];
    let x2 = bbox[2];
    let y1 = bbox[1];
    let y2 = bbox[5];
    const width = x2 - x1;
    const height = y2 - y1;
    const xPad = height * xRatio;
    const yPad = width * yRatio;
    x1 -= xPad;
    x2 += xPad;
    y1 -= yPad;
    y2 += yPad;
    return [x1, y1, x2, y1, x2, y2, x1, y2];
}

export const scaleBbox = (bbox: number[], xRatio, yRatio) => {
    return bbox.map((c, i) => i % 2 ? c * yRatio: c * xRatio);
}