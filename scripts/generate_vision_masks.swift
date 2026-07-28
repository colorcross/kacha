#!/usr/bin/env swift

import AppKit
import AVFoundation
import CryptoKit
import CoreImage
import CoreMedia
import CoreVideo
import Foundation
import Vision

struct FaceRecord: Codable {
    let confidence: Float
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let landmarksAvailable: Bool
    let isPrimary: Bool
}

struct FrameRecord: Codable {
    let index: Int
    let timeSeconds: Double
    let personMask: String?
    let faceMask: String?
    let skinMask: String?
    let nasolabialMask: String?
    let faces: [FaceRecord]
    let primaryFaceIndex: Int?
    let primaryTrackingStatus: String
    let primaryLandmarksAvailable: Bool
    let primaryJumpRatio: Double?
    let candidateCount: Int
    let beautyMaskApplied: Bool
}

struct TrackingSummary: Codable {
    let primaryFrameCount: Int
    let landmarkFrameCount: Int
    let ambiguousFrameCount: Int
    let dropoutFrameCount: Int
    let beautyMaskFrameCount: Int
    let primaryFaceCoverage: Double
    let landmarkCoverage: Double
    let ambiguousFrameRatio: Double
    let maximumTrackingJumpRatio: Double
}

struct Manifest: Codable {
    let input: String
    let sourceSha256: String
    let generatedAt: String
    let sampleFPS: Double
    let sourceFPS: Double
    let sourceDuration: Double
    let sourceWidth: Int
    let sourceHeight: Int
    let maskWidth: Int
    let maskHeight: Int
    let quality: String
    let frameCount: Int
    let frames: [FrameRecord]
    let tracking: TrackingSummary
    let limitations: [String]
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(2)
}

func usage() -> Never {
    fail("""
    Usage:
      generate_vision_masks.swift INPUT_VIDEO OUTPUT_DIR [sample_fps] [fast|balanced|accurate]

    Generates:
      person_000001.png ...  Person segmentation masks
      face_000001.png ...    Soft face-region masks
      skin_000001.png ...    Face skin masks with landmark protection
      nasolabial_000001.png . Nasolabial-fold softening masks
      manifest.json          Timing, dimensions and normalized face boxes

    For final rendering, use sample_fps equal to the source frame rate. Lower values
    are intended only for capability checks and effect planning.
    """)
}

guard CommandLine.arguments.count >= 3 else { usage() }

let inputPath = CommandLine.arguments[1]
let outputPath = CommandLine.arguments[2]
let sampleFPS = CommandLine.arguments.count >= 4 ? (Double(CommandLine.arguments[3]) ?? 5.0) : 5.0
let qualityName = CommandLine.arguments.count >= 5 ? CommandLine.arguments[4] : "balanced"

guard sampleFPS > 0 else { fail("sample_fps must be greater than zero") }
guard FileManager.default.fileExists(atPath: inputPath) else { fail("Input not found: \(inputPath)") }

let quality: VNGeneratePersonSegmentationRequest.QualityLevel
switch qualityName {
case "fast": quality = .fast
case "balanced": quality = .balanced
case "accurate": quality = .accurate
default: fail("quality must be fast, balanced or accurate")
}

let inputURL = URL(fileURLWithPath: inputPath)
let outputURL = URL(fileURLWithPath: outputPath, isDirectory: true)
if FileManager.default.fileExists(atPath: outputURL.path) {
    let existing = try FileManager.default.contentsOfDirectory(
        at: outputURL,
        includingPropertiesForKeys: nil
    )
    guard existing.isEmpty else {
        fail("Output directory must be empty to prevent stale mask frames: \(outputURL.path)")
    }
} else {
    try FileManager.default.createDirectory(at: outputURL, withIntermediateDirectories: true)
}

let asset = AVURLAsset(url: inputURL)
guard let track = try await asset.loadTracks(withMediaType: .video).first else {
    fail("No video track found")
}

let transform = try await track.load(.preferredTransform)
let transformIsIdentity =
    abs(transform.a - 1.0) < 0.0001 &&
    abs(transform.b) < 0.0001 &&
    abs(transform.c) < 0.0001 &&
    abs(transform.d - 1.0) < 0.0001 &&
    abs(transform.tx) < 0.0001 &&
    abs(transform.ty) < 0.0001
guard transformIsIdentity else {
    fail("The source uses rotation, mirroring or translation metadata. Normalize it to an upright intermediate before mask generation.")
}

let naturalSize = try await track.load(.naturalSize)
let nominalFrameRate = try await track.load(.nominalFrameRate)
let durationTime = try await asset.load(.duration)
let sourceDuration = durationTime.seconds
let sourceWidth = Int(naturalSize.width.rounded())
let sourceHeight = Int(naturalSize.height.rounded())
let sourceFPS = nominalFrameRate > 0 ? Double(nominalFrameRate) : 25.0
guard sourceDuration.isFinite && sourceDuration > 0 else {
    fail("Could not determine a valid source duration")
}

func sha256File(_ url: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var hasher = SHA256()
    while true {
        let data = try handle.read(upToCount: 1024 * 1024) ?? Data()
        if data.isEmpty { break }
        hasher.update(data: data)
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
}

let sourceSha256 = try sha256File(inputURL)

guard let reader = try? AVAssetReader(asset: asset) else { fail("Could not create AVAssetReader") }
let output = AVAssetReaderTrackOutput(
    track: track,
    outputSettings: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
    ]
)
output.alwaysCopiesSampleData = false
guard reader.canAdd(output) else { fail("Could not add video reader output") }
reader.add(output)
guard reader.startReading() else { fail("Could not start reading video") }

let personRequest = VNGeneratePersonSegmentationRequest()
personRequest.qualityLevel = quality
personRequest.outputPixelFormat = kCVPixelFormatType_OneComponent8

let faceRequest = VNDetectFaceLandmarksRequest()
let ciContext = CIContext(options: [.useSoftwareRenderer: false])
let interval = 1.0 / sampleFPS
var nextSampleTime = 0.0
var records: [FrameRecord] = []
var outputIndex = 0
var maskWidth = 0
var maskHeight = 0
var previousPrimaryBox: CGRect?
var previousFrameHadStablePrimary = false

func writePNG(from pixelBuffer: CVPixelBuffer, to url: URL) throws {
    let image = CIImage(cvPixelBuffer: pixelBuffer)
    guard let cgImage = ciContext.createCGImage(image, from: image.extent) else {
        throw NSError(domain: "KachaVision", code: 1, userInfo: [NSLocalizedDescriptionKey: "Could not create CGImage"])
    }
    let bitmap = NSBitmapImageRep(cgImage: cgImage)
    guard let data = bitmap.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "KachaVision", code: 2, userInfo: [NSLocalizedDescriptionKey: "Could not encode PNG"])
    }
    try data.write(to: url)
}

func intersectionOverUnion(_ left: CGRect, _ right: CGRect) -> Double {
    let intersection = left.intersection(right)
    guard !intersection.isNull, intersection.width > 0, intersection.height > 0 else {
        return 0
    }
    let intersectionArea = intersection.width * intersection.height
    let unionArea = left.width * left.height + right.width * right.height - intersectionArea
    return unionArea > 0 ? intersectionArea / unionArea : 0
}

func trackingJump(_ current: CGRect, _ previous: CGRect) -> Double {
    let dx = current.midX - previous.midX
    let dy = current.midY - previous.midY
    let previousDiagonal = max(0.001, hypot(previous.width, previous.height))
    return hypot(dx, dy) / previousDiagonal
}

func selectPrimaryFace(
    faces: [VNFaceObservation],
    previous: CGRect?
) -> (index: Int?, status: String, jumpRatio: Double?, ambiguous: Bool, candidates: Int) {
    let candidates = faces.enumerated().filter {
        $0.element.confidence >= 0.5 && $0.element.landmarks != nil
    }
    guard !candidates.isEmpty else {
        return (nil, "dropout", nil, false, 0)
    }

    let ranked: [(index: Int, observation: VNFaceObservation, score: Double)] =
        candidates.map { candidate in
            let box = candidate.element.boundingBox
            let areaScore = min(1, box.width * box.height * 7)
            let centerDistance = hypot(box.midX - 0.5, box.midY - 0.5)
            let centerScore = max(0, 1 - centerDistance / 0.72)
            let score: Double
            if let previous {
                let overlap = intersectionOverUnion(box, previous)
                let jump = trackingJump(box, previous)
                let continuity = max(0, 1 - min(1, jump))
                score = overlap * 0.62 + continuity * 0.27 + areaScore * 0.11
            } else {
                score = areaScore * 0.68 + centerScore * 0.32
            }
            return (candidate.offset, candidate.element, score)
        }
        .sorted { $0.score > $1.score }

    let best = ranked[0]
    let scoreGap = ranked.count > 1 ? best.score - ranked[1].score : 1
    let ambiguous = ranked.count > 1 && scoreGap < 0.08
    let jump = previous.map { trackingJump(best.observation.boundingBox, $0) }
    let status: String
    if ambiguous {
        status = "ambiguous"
    } else if previous == nil {
        status = "acquired"
    } else if !previousFrameHadStablePrimary || (jump ?? 0) > 0.32 {
        status = "reacquired"
    } else {
        status = "locked"
    }
    return (best.index, status, jump, ambiguous, candidates.count)
}

func writeFaceMask(
    width: Int,
    height: Int,
    face: VNFaceObservation?,
    to url: URL
) throws {
    let colorSpace = CGColorSpaceCreateDeviceGray()
    guard let context = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: width,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.none.rawValue
    ) else {
        throw NSError(domain: "KachaVision", code: 3, userInfo: [NSLocalizedDescriptionKey: "Could not create mask context"])
    }

    context.setFillColor(gray: 0, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.setFillColor(gray: 1, alpha: 1)

    if let face {
        let box = face.boundingBox
        let expandedX = max(0, box.minX - box.width * 0.10)
        let expandedY = max(0, box.minY - box.height * 0.10)
        let expandedW = min(1 - expandedX, box.width * 1.20)
        let expandedH = min(1 - expandedY, box.height * 1.22)
        let rect = CGRect(
            x: expandedX * Double(width),
            y: expandedY * Double(height),
            width: expandedW * Double(width),
            height: expandedH * Double(height)
        )
        context.fillEllipse(in: rect)
    }

    guard let cgImage = context.makeImage() else {
        throw NSError(domain: "KachaVision", code: 4, userInfo: [NSLocalizedDescriptionKey: "Could not create face mask image"])
    }
    let bitmap = NSBitmapImageRep(cgImage: cgImage)
    guard let data = bitmap.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "KachaVision", code: 5, userInfo: [NSLocalizedDescriptionKey: "Could not encode face mask PNG"])
    }
    try data.write(to: url)
}

func landmarkRect(
    _ regions: [VNFaceLandmarkRegion2D?],
    faceBox: CGRect,
    width: Int,
    height: Int,
    expandX: Double,
    expandY: Double
) -> CGRect? {
    let points = regions.compactMap { $0 }.flatMap { Array($0.normalizedPoints) }
    guard !points.isEmpty else { return nil }
    let xs = points.map { faceBox.minX + Double($0.x) * faceBox.width }
    let ys = points.map { faceBox.minY + Double($0.y) * faceBox.height }
    let minX = max(0, (xs.min() ?? faceBox.minX) - faceBox.width * expandX)
    let maxX = min(1, (xs.max() ?? faceBox.maxX) + faceBox.width * expandX)
    let minY = max(0, (ys.min() ?? faceBox.minY) - faceBox.height * expandY)
    let maxY = min(1, (ys.max() ?? faceBox.maxY) + faceBox.height * expandY)
    return CGRect(
        x: minX * Double(width),
        y: minY * Double(height),
        width: (maxX - minX) * Double(width),
        height: (maxY - minY) * Double(height)
    )
}

func writeSkinMask(
    width: Int,
    height: Int,
    face: VNFaceObservation?,
    to url: URL
) throws {
    let colorSpace = CGColorSpaceCreateDeviceGray()
    guard let context = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: width,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.none.rawValue
    ) else {
        throw NSError(domain: "KachaVision", code: 6, userInfo: [NSLocalizedDescriptionKey: "Could not create skin mask context"])
    }

    context.setFillColor(gray: 0, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))

    if let face, let landmarks = face.landmarks {
        let box = face.boundingBox
        let startX = max(0, box.minX + box.width * 0.035)
        let startY = max(0, box.minY + box.height * 0.015)
        let skinRect = CGRect(
            x: startX * Double(width),
            y: startY * Double(height),
            width: min(1 - startX, box.width * 0.93) * Double(width),
            height: min(1 - startY, box.height * 0.97) * Double(height)
        )
        context.setBlendMode(.normal)
        context.setFillColor(gray: 1, alpha: 1)
        context.fillEllipse(in: skinRect)

        let earWidth = box.width * 0.15
        let earHeight = box.height * 0.32
        let earY = box.minY + box.height * 0.38
        let leftEarX = max(CGFloat(0), box.minX - earWidth * 0.45)
        let leftEar = CGRect(
            x: leftEarX * CGFloat(width),
            y: earY * CGFloat(height),
            width: min(CGFloat(1) - leftEarX, earWidth) * CGFloat(width),
            height: min(CGFloat(1) - earY, earHeight) * CGFloat(height)
        )
        let rightEarX = min(CGFloat(1), box.maxX - earWidth * 0.55)
        let rightEar = CGRect(
            x: rightEarX * CGFloat(width),
            y: earY * CGFloat(height),
            width: min(CGFloat(1) - rightEarX, earWidth) * CGFloat(width),
            height: min(CGFloat(1) - earY, earHeight) * CGFloat(height)
        )
        context.fillEllipse(in: leftEar)
        context.fillEllipse(in: rightEar)

        let neckWidth = box.width * 0.44
        let neckX = max(CGFloat(0), box.midX - neckWidth / 2)
        let neckY = max(CGFloat(0), box.minY - box.height * 0.24)
        let neckRect = CGRect(
            x: neckX * CGFloat(width),
            y: neckY * CGFloat(height),
            width: min(CGFloat(1) - neckX, neckWidth) * CGFloat(width),
            height: min(CGFloat(1) - neckY, box.height * 0.34) * CGFloat(height)
        )
        context.fillEllipse(in: neckRect)

        context.setBlendMode(.clear)
        if let eyeBand = landmarkRect(
            [landmarks.leftEye, landmarks.rightEye, landmarks.leftEyebrow, landmarks.rightEyebrow],
            faceBox: box,
            width: width,
            height: height,
            expandX: 0.075,
            expandY: 0.055
        ) {
            context.fillEllipse(in: eyeBand)
        }
        if let lips = landmarkRect(
            [landmarks.outerLips, landmarks.innerLips],
            faceBox: box,
            width: width,
            height: height,
            expandX: 0.045,
            expandY: 0.055
        ) {
            context.fillEllipse(in: lips)
        }
    }

    guard let cgImage = context.makeImage() else {
        throw NSError(domain: "KachaVision", code: 7, userInfo: [NSLocalizedDescriptionKey: "Could not create skin mask image"])
    }
    let bitmap = NSBitmapImageRep(cgImage: cgImage)
    guard let data = bitmap.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "KachaVision", code: 8, userInfo: [NSLocalizedDescriptionKey: "Could not encode skin mask PNG"])
    }
    try data.write(to: url)
}

func globalPoints(
    _ region: VNFaceLandmarkRegion2D,
    faceBox: CGRect
) -> [CGPoint] {
    region.normalizedPoints.map {
        CGPoint(
            x: faceBox.minX + Double($0.x) * faceBox.width,
            y: faceBox.minY + Double($0.y) * faceBox.height
        )
    }
}

func boundsForPoints(_ points: [CGPoint]) -> CGRect? {
    guard !points.isEmpty else { return nil }
    let xs = points.map(\.x)
    let ys = points.map(\.y)
    guard
        let minX = xs.min(),
        let maxX = xs.max(),
        let minY = ys.min(),
        let maxY = ys.max()
    else { return nil }
    return CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
}

func writeNasolabialMask(
    width: Int,
    height: Int,
    face: VNFaceObservation?,
    to url: URL
) throws {
    let colorSpace = CGColorSpaceCreateDeviceGray()
    guard let context = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: width,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.none.rawValue
    ) else {
        throw NSError(domain: "KachaVision", code: 9, userInfo: [NSLocalizedDescriptionKey: "Could not create nasolabial mask context"])
    }

    context.setFillColor(gray: 0, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.setStrokeColor(gray: 1, alpha: 0.82)
    context.setLineCap(.round)
    context.setLineJoin(.round)

    if let face {
        guard
            face.confidence >= 0.5,
            let landmarks = face.landmarks,
            let nose = landmarks.nose,
            let lips = landmarks.outerLips,
            let noseBounds = boundsForPoints(globalPoints(nose, faceBox: face.boundingBox)),
            let lipBounds = boundsForPoints(globalPoints(lips, faceBox: face.boundingBox))
        else {
            guard let cgImage = context.makeImage() else {
                throw NSError(domain: "KachaVision", code: 10, userInfo: [NSLocalizedDescriptionKey: "Could not create nasolabial mask image"])
            }
            let bitmap = NSBitmapImageRep(cgImage: cgImage)
            guard let data = bitmap.representation(using: .png, properties: [:]) else {
                throw NSError(domain: "KachaVision", code: 11, userInfo: [NSLocalizedDescriptionKey: "Could not encode nasolabial mask PNG"])
            }
            try data.write(to: url)
            return
        }

        let box = face.boundingBox
        let lineWidth = max(2, box.width * Double(width) * 0.052)
        context.setLineWidth(lineWidth)

        let leftStart = CGPoint(
            x: (noseBounds.minX - box.width * 0.012) * Double(width),
            y: (noseBounds.minY + noseBounds.height * 0.3) * Double(height)
        )
        let leftEnd = CGPoint(
            x: (lipBounds.minX - box.width * 0.03) * Double(width),
            y: (lipBounds.midY + box.height * 0.015) * Double(height)
        )
        let leftControl1 = CGPoint(
            x: (noseBounds.minX - box.width * 0.05) * Double(width),
            y: (noseBounds.minY - box.height * 0.025) * Double(height)
        )
        let leftControl2 = CGPoint(
            x: (lipBounds.minX - box.width * 0.055) * Double(width),
            y: (lipBounds.maxY + box.height * 0.02) * Double(height)
        )

        let rightStart = CGPoint(
            x: (noseBounds.maxX + box.width * 0.012) * Double(width),
            y: (noseBounds.minY + noseBounds.height * 0.3) * Double(height)
        )
        let rightEnd = CGPoint(
            x: (lipBounds.maxX + box.width * 0.03) * Double(width),
            y: (lipBounds.midY + box.height * 0.015) * Double(height)
        )
        let rightControl1 = CGPoint(
            x: (noseBounds.maxX + box.width * 0.05) * Double(width),
            y: (noseBounds.minY - box.height * 0.025) * Double(height)
        )
        let rightControl2 = CGPoint(
            x: (lipBounds.maxX + box.width * 0.055) * Double(width),
            y: (lipBounds.maxY + box.height * 0.02) * Double(height)
        )

        context.beginPath()
        context.move(to: leftStart)
        context.addCurve(
            to: leftEnd,
            control1: leftControl1,
            control2: leftControl2
        )
        context.strokePath()
        context.beginPath()
        context.move(to: rightStart)
        context.addCurve(
            to: rightEnd,
            control1: rightControl1,
            control2: rightControl2
        )
        context.strokePath()
    }

    guard let cgImage = context.makeImage() else {
        throw NSError(domain: "KachaVision", code: 10, userInfo: [NSLocalizedDescriptionKey: "Could not create nasolabial mask image"])
    }
    let bitmap = NSBitmapImageRep(cgImage: cgImage)
    guard let data = bitmap.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "KachaVision", code: 11, userInfo: [NSLocalizedDescriptionKey: "Could not encode nasolabial mask PNG"])
    }
    try data.write(to: url)
}

while reader.status == .reading, let sampleBuffer = output.copyNextSampleBuffer() {
    let time = CMSampleBufferGetPresentationTimeStamp(sampleBuffer).seconds
    if time + 0.0001 < nextSampleTime { continue }
    repeat {
        nextSampleTime += interval
    } while nextSampleTime <= time + 0.0001

    guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { continue }
    let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: .up, options: [:])

    do {
        try handler.perform([personRequest, faceRequest])
    } catch {
        FileHandle.standardError.write(Data(("Vision failed at \(time)s: \(error)\n").utf8))
        continue
    }

    outputIndex += 1
    let sequence = String(format: "%06d", outputIndex)
    var personName: String?
    var faceName: String?
    var skinName: String?
    var nasolabialName: String?

    if let observation = personRequest.results?.first {
        let buffer = observation.pixelBuffer
        maskWidth = CVPixelBufferGetWidth(buffer)
        maskHeight = CVPixelBufferGetHeight(buffer)
        let name = "person_\(sequence).png"
        try writePNG(from: buffer, to: outputURL.appendingPathComponent(name))
        personName = name
    }

    let faces = faceRequest.results ?? []
    let selection = selectPrimaryFace(faces: faces, previous: previousPrimaryBox)
    let selectedFace = selection.index.map { faces[$0] }
    let effectFace = selection.ambiguous ? nil : selectedFace
    if let selectedFace, !selection.ambiguous {
        previousPrimaryBox = selectedFace.boundingBox
        previousFrameHadStablePrimary = true
    } else {
        previousFrameHadStablePrimary = false
    }
    if maskWidth > 0 && maskHeight > 0 {
        let name = "face_\(sequence).png"
        try writeFaceMask(
            width: maskWidth,
            height: maskHeight,
            face: effectFace,
            to: outputURL.appendingPathComponent(name)
        )
        faceName = name

        let skinMaskName = "skin_\(sequence).png"
        try writeSkinMask(
            width: maskWidth,
            height: maskHeight,
            face: effectFace,
            to: outputURL.appendingPathComponent(skinMaskName)
        )
        skinName = skinMaskName

        let nasolabialMaskName = "nasolabial_\(sequence).png"
        try writeNasolabialMask(
            width: maskWidth,
            height: maskHeight,
            face: effectFace,
            to: outputURL.appendingPathComponent(nasolabialMaskName)
        )
        nasolabialName = nasolabialMaskName
    }

    let faceRecords = faces.enumerated().map { index, face in
        FaceRecord(
            confidence: face.confidence,
            x: face.boundingBox.minX,
            y: face.boundingBox.minY,
            width: face.boundingBox.width,
            height: face.boundingBox.height,
            landmarksAvailable: face.landmarks != nil,
            isPrimary: index == selection.index
        )
    }

    records.append(
        FrameRecord(
            index: outputIndex,
            timeSeconds: time,
            personMask: personName,
            faceMask: faceName,
            skinMask: skinName,
            nasolabialMask: nasolabialName,
            faces: faceRecords,
            primaryFaceIndex: selection.index,
            primaryTrackingStatus: selection.status,
            primaryLandmarksAvailable: selectedFace?.landmarks != nil,
            primaryJumpRatio: selection.jumpRatio,
            candidateCount: selection.candidates,
            beautyMaskApplied: effectFace != nil
        )
    )
}

guard !records.isEmpty else { fail("No masks were generated") }
guard reader.status == .completed else {
    fail("Video reader did not complete successfully: \(reader.error?.localizedDescription ?? "unknown error")")
}

let formatter = ISO8601DateFormatter()
let primaryFrameCount = records.filter {
    ["acquired", "locked", "reacquired"].contains($0.primaryTrackingStatus)
}.count
let landmarkFrameCount = records.filter {
    $0.primaryLandmarksAvailable && $0.beautyMaskApplied
}.count
let ambiguousFrameCount = records.filter {
    $0.primaryTrackingStatus == "ambiguous"
}.count
let dropoutFrameCount = records.filter {
    $0.primaryTrackingStatus == "dropout"
}.count
let beautyMaskFrameCount = records.filter(\.beautyMaskApplied).count
let maximumTrackingJumpRatio = records.compactMap(\.primaryJumpRatio).max() ?? 0
let tracking = TrackingSummary(
    primaryFrameCount: primaryFrameCount,
    landmarkFrameCount: landmarkFrameCount,
    ambiguousFrameCount: ambiguousFrameCount,
    dropoutFrameCount: dropoutFrameCount,
    beautyMaskFrameCount: beautyMaskFrameCount,
    primaryFaceCoverage: Double(primaryFrameCount) / Double(records.count),
    landmarkCoverage: Double(landmarkFrameCount) / Double(records.count),
    ambiguousFrameRatio: Double(ambiguousFrameCount) / Double(records.count),
    maximumTrackingJumpRatio: maximumTrackingJumpRatio
)
let manifest = Manifest(
    input: inputURL.path,
    sourceSha256: sourceSha256,
    generatedAt: formatter.string(from: Date()),
    sampleFPS: sampleFPS,
    sourceFPS: sourceFPS,
    sourceDuration: sourceDuration,
    sourceWidth: sourceWidth,
    sourceHeight: sourceHeight,
    maskWidth: maskWidth,
    maskHeight: maskHeight,
    quality: qualityName,
    frameCount: records.count,
    frames: records,
    tracking: tracking,
    limitations: [
        "Beauty masks lock one primary presenter across frames. Ambiguous multi-face frames receive blank Beauty masks and must pass coverage QC.",
        "Skin masks use conservative face, ear and neck geometry with landmark-protected eye, eyebrow and lip regions; they are not pixel-level semantic skin segmentation.",
        "Nasolabial masks are conservative landmark-derived fold regions and only support contrast softening, not semantic wrinkle removal.",
        "Hands and arms are intentionally excluded. Face, ear and neck masks require visual validation at occlusions, fast motion, glasses, hands near the face and edge frames.",
        "Beauty masks do not change facial geometry and must not be presented as face slimming, eye enlargement or nose reshaping.",
        "This tool rejects sources that rely on rotation metadata; normalize orientation first."
    ]
)

let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
let manifestData = try encoder.encode(manifest)
try manifestData.write(
    to: outputURL.appendingPathComponent("manifest.json"),
    options: .atomic
)

print(outputURL.path)
