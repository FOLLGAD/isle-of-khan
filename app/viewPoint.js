
// viewPoint, camera

var tileMapWidth = mapArray[0].length;
var tileMapHeight = mapArray.length;

var mapSizeX = tileMapWidth * tileSize;
var mapSizeY = tileMapHeight * tileSize;

var offsetMaxX = mapSizeX - canvas.width;
var offsetMaxY = mapSizeY - canvas.height;
var offsetMinX = 0;
var offsetMinY = 0;

var camX = 0;
var camY = 0;

function isTileWall(i, j) {
  if (mapArray[j][i] == 3) {
    return true;
  } else {
    return false;
  }
}

function tilesSurrounding() {
  tileX[0] = (charX - charX % tileSize) / tileSize;
  tileY[0] = (charY - charY % tileSize) / tileSize;
  tileX[1] = tileX[0] + 1;
  tileY[1] = tileY[0];
  tileX[2] = tileX[0];
  tileY[2] = tileY[0] + 1;
  tileX[3] = tileX[1];
  tileY[3] = tileY[2];
  ctx.beginPath();
  ctx.rect(tileX[0] * tileSize, tileY[0] * tileSize, tileSize * 2, tileSize * 2);
  ctx.closePath();
  ctx.stroke();
}

function checkCharCollision() {
  tilesSurrounding();
  for(i = 0; i < 4; i++) {
      if(isTileWall(tileX[i], tileY[i])) {
        checkTileCollision(tileX[i], tileY[i]);
    }
  }
}

function checkTileCollision(i, j) {
  var colDistanceX = (i * tileSize + tileSize / 2) - (charX + charWidth / 2);
  var colDistanceY = (j * tileSize + tileSize / 2) - (charY + charHeight / 2);

  ctx.beginPath();
  ctx.rect((i * tileSize + tileSize / 2), (charY + charHeight / 2), charWidth, charHeight);
  ctx.closePath();
  ctx.stroke();

  if (Math.abs(colDistanceX) < Math.abs(colDistanceY)) {
    // Flyttas till ner/upp , Y-led
    if (colDistanceY > 0) {
      charY = j * tileSize - charWidth;
      console.log("1");
    } else {
      charY = j * tileSize + tileSize;
      console.log("2");
    }
  } else {
    // Flyttas till höger/vänster , X-led
    if (colDistanceX > 0) {
      charX = i * tileSize - charHeight;
      console.log("3");
    } else {
      charX = i * tileSize + tileSize;
      console.log("4");
    }

  }
}

function drawCollision() {
}

function viewPoint() {

  camX = charX + charWidth / 2 - canvas.width / 2;
  camY = charY + charHeight / 2 - canvas.height / 2;

  if (camX > offsetMaxX) {
    camX = offsetMaxX;
  } else if (camX < offsetMinX) {
    camX = offsetMinX;
  }
  if (camY > offsetMaxY) {
    camY = offsetMaxY;
  } else if (camY < offsetMinY) {
    camY = offsetMinY;
  }
  ctx.translate(-camX, -camY);
}
