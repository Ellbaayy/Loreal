#!/bin/bash
# Script to upload existing perfume images to imgbb and update TiDB Cloud database
# Run: bash migrate_images.sh

IMGBB_KEY="1a79a960f58c18277471051aa4740f8c"
DB_HOST="gateway01.ap-southeast-1.prod.aws.tidbcloud.com"
DB_PORT=4000
DB_USER="2EaAigcj6yFUTcZ.root"
DB_PASS="ohY0Z0UfsOHk4YEP"
DB_NAME="lore_ai_db"

upload_to_imgbb() {
  local filepath="$1"
  local filename=$(basename "$filepath")
  echo "  Uploading $filename..."
  local response=$(curl -s -X POST "https://api.imgbb.com/1/upload?key=$IMGBB_KEY" \
    -F "image=@$filepath")
  local url=$(echo "$response" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data',{}).get('url','') or '')" 2>/dev/null)
  echo "$url"
}

# Get current perfumes with local image URLs
echo "Fetching perfumes from database..."
perfumes=$(mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" \
  -e "SELECT id, name, image_url FROM perfumes WHERE image_url IS NOT NULL AND image_url != '' AND image_url NOT LIKE 'https://%'" \
  --batch --raw 2>/dev/null)

if [ -z "$perfumes" ]; then
  echo "No local images found in database."
  exit 0
fi

echo "$perfumes" | while IFS=$'\t' read -r id name image_url; do
  if [ -z "$id" ] || [ "$id" = "id" ]; then continue; fi
  
  local_path="/home/ellbaay/Documents/Loreal/LORE-AI/$image_url"
  if [ -f "$local_path" ]; then
    echo "Processing: $name (id=$id)"
    imgbb_url=$(upload_to_imgbb "$local_path")
    if [ -n "$imgbb_url" ]; then
      echo "  -> $imgbb_url"
      mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" \
        -e "UPDATE perfumes SET image_url='$imgbb_url' WHERE id=$id" 2>/dev/null
      echo "  ✅ Updated id=$id"
    else
      echo "  ❌ Failed to upload"
    fi
  else
    echo "  ⚠️ File not found: $local_path"
  fi
done

echo "Migration complete!"
