import os

# Refuse decompression bombs: a tiny PNG can claim billions of pixels. OpenCV reads this limit when it first
# decodes, so it is set before any module imports cv2. 40 megapixels covers any camera or phone photo.
os.environ.setdefault("OPENCV_IO_MAX_IMAGE_PIXELS", str(40_000_000))
