import os
from PIL import Image, ImageChops

def create_transparent_icons(input_path, output_dir='icons'):
    os.makedirs(output_dir, exist_ok=True)
    
    # Open the image
    img = Image.open(input_path).convert('RGBA')
    width, height = img.size
    
    # 1. Crop to square from the center
    size = min(width, height)
    left = (width - size) // 2
    top = (height - size) // 2
    right = left + size
    bottom = top + size
    img_cropped = img.crop((left, top, right, bottom))
    
    # 2. Make background transparent
    # We sample the corner pixel (0, 0) to detect the background color
    bg_color = img_cropped.getpixel((0, 0))
    
    # Create a new transparent image
    datas = img_cropped.getdata()
    new_data = []
    
    # Threshold for color matching to handle compression artifacts
    threshold = 30
    
    for item in datas:
        # Check if the pixel color is close to the background color
        if (abs(item[0] - bg_color[0]) < threshold and 
            abs(item[1] - bg_color[1]) < threshold and 
            abs(item[2] - bg_color[2]) < threshold):
            # Make it transparent
            new_data.append((255, 255, 255, 0))
        else:
            # Keep original pixel, but make sure alpha is full if not transparent
            new_data.append((item[0], item[1], item[2], 255))
            
    img_cropped.putdata(new_data)
    
    # Trim excess transparent space around the icon to maximize visibility
    # Get the bounding box of non-transparent pixels
    bbox = img_cropped.getbbox()
    if bbox:
        img_cropped = img_cropped.crop(bbox)
        # Add a small padding (e.g., 5%) so the icon doesn't touch the borders
        w, h = img_cropped.size
        square_size = max(w, h)
        padded = Image.new('RGBA', (int(square_size * 1.1), int(square_size * 1.1)), (255, 255, 255, 0))
        # Center the cropped image in the padded square
        x = (padded.width - w) // 2
        y = (padded.height - h) // 2
        padded.paste(img_cropped, (x, y))
        img_cropped = padded
    
    # 3. Resize and save
    for icon_size in [16, 48, 128]:
        resized = img_cropped.resize((icon_size, icon_size), Image.Resampling.LANCZOS)
        out_path = os.path.join(output_dir, f'icon{icon_size}.png')
        resized.save(out_path, 'PNG')
        print(f"Created {out_path} ({icon_size}x{icon_size}) with transparent background")

if __name__ == '__main__':
    create_transparent_icons('nanobanana-output/an_extremely_simple_minimalist_g.png')
