// fonino-ocr <image> <x> <y> <w> <h>  (rect in image points, origin top-left)
// Prints the text lines Apple's Vision framework finds inside the rect, one per line.
// fonino-ocr <image> all
// Prints every text line on the image as "text<TAB>cx<TAB>cy" (line center, 0–1, origin top-left).
// Used to read the label of the button under a tap point quickly (~100–300 ms), even on web
// pages whose accessibility tree is too large to query.
import AppKit
import Vision

let a = CommandLine.arguments
if a.count == 3, a[2] == "all", let img = NSImage(contentsOfFile: a[1]), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) {
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = .accurate
  req.usesLanguageCorrection = false
  try? VNImageRequestHandler(cgImage: cg).perform([req])
  for o in req.results ?? [] {
    guard let t = o.topCandidates(1).first?.string else { continue }
    let b = o.boundingBox
    print("\(t.replacingOccurrences(of: "\t", with: " "))\t\(b.midX)\t\(1 - b.midY)")
  }
  exit(0)
}
guard a.count == 6, let img = NSImage(contentsOfFile: a[1]),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil),
      let x = Double(a[2]), let y = Double(a[3]), let w = Double(a[4]), let h = Double(a[5]) else {
  FileHandle.standardError.write("usage: fonino-ocr <image> <x> <y> <w> <h>\n".data(using: .utf8)!); exit(2)
}
let W = Double(cg.width), H = Double(cg.height)
// Vision's regionOfInterest is normalized with origin bottom-left.
let roi = CGRect(x: max(0, x / W), y: max(0, 1 - (y + h) / H), width: min(1, w / W), height: min(1, h / H))
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.usesLanguageCorrection = false
req.regionOfInterest = roi.intersection(CGRect(x: 0, y: 0, width: 1, height: 1))
try? VNImageRequestHandler(cgImage: cg).perform([req])
for o in req.results ?? [] { if let t = o.topCandidates(1).first?.string { print(t) } }
