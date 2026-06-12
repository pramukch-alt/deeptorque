import os
from PIL import Image, ImageDraw, ImageFont

def create_industrial_icon(size, filename):
    # Create image with dark charcoal background
    bg_color = (18, 18, 18)
    image = Image.new("RGBA", (size, size), bg_color)
    draw = ImageDraw.Draw(image)
    
    # Coordinates of center
    center = size // 2
    padding = size // 6
    radius = size // 2 - padding
    
    # Draw safety orange geometric hexagon in the center representing a bolt head
    orange_color = (255, 122, 0)
    import math
    points = []
    for i in range(6):
        angle = math.radians(i * 60 - 30)  # offset to point upward
        x = center + int(radius * 0.55 * math.cos(angle))
        y = center + int(radius * 0.55 * math.sin(angle))
        points.append((x, y))
    draw.polygon(points, fill=orange_color)
    
    # Draw a dark gray circle inside the hexagon to represent the bolt core
    dark_gray = (40, 40, 40)
    inner_radius = int(radius * 0.25)
    draw.ellipse([center - inner_radius, center - inner_radius, 
                  center + inner_radius, center + inner_radius], 
                 fill=dark_gray)
    
    # Draw a stylized safety orange arc representing torque rotation / wrench
    # Draw arc from -45 to 225 degrees (leaving a gap)
    arc_width = max(2, size // 24)
    draw.arc([center - radius, center - radius, center + radius, center + radius],
             start=-45, end=225, fill=orange_color, width=arc_width)
    
    # Draw a stylized arrow at the end of the arc (at 225 degrees)
    # 225 degrees is bottom-left
    arrow_angle = math.radians(225)
    arrow_tip_x = center + int(radius * math.cos(arrow_angle))
    arrow_tip_y = center + int(radius * math.sin(arrow_angle))
    
    # Arrow head wings
    wing_angle1 = math.radians(225 - 45)
    wing_angle2 = math.radians(225 + 45)
    wing_len = radius * 0.2
    
    wing1_x = arrow_tip_x + int(wing_len * math.cos(wing_angle1))
    wing1_y = arrow_tip_y + int(wing_len * math.sin(wing_angle1))
    
    wing2_x = arrow_tip_x + int(wing_len * math.cos(wing_angle2))
    wing2_y = arrow_tip_y + int(wing_len * math.sin(wing_angle2))
    
    draw.line([arrow_tip_x, arrow_tip_y, wing1_x, wing1_y], fill=orange_color, width=arc_width)
    draw.line([arrow_tip_x, arrow_tip_y, wing2_x, wing2_y], fill=orange_color, width=arc_width)

    # Save to disk
    image.save(filename, "PNG")
    print(f"Generated PWA Icon: {filename} ({size}x{size})")

if __name__ == "__main__":
    create_industrial_icon(192, "icon-192.png")
    create_industrial_icon(512, "icon-512.png")
