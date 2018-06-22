/* global THREE, AFRAME, Element  */
var cylinderTexture = require('./lib/cylinderTexture');
var parabolicCurve = require('./lib/ParabolicCurve');
var RayCurve = require('./lib/RayCurve');

if (typeof AFRAME === 'undefined') {
  throw new Error('Component attempted to register before AFRAME was available.');
}

if (!Element.prototype.matches) {
  Element.prototype.matches =
    Element.prototype.matchesSelector ||
    Element.prototype.mozMatchesSelector ||
    Element.prototype.msMatchesSelector ||
    Element.prototype.oMatchesSelector ||
    Element.prototype.webkitMatchesSelector ||
    function (s) {
      var matches = (this.document || this.ownerDocument).querySelectorAll(s);
      var i = matches.length;
      while (--i >= 0 && matches.item(i) !== this) { /* no-op */ }
      return i > -1;
    };
}

AFRAME.registerComponent('teleport-controls', {
  schema: {
    type: {default: 'parabolic', oneOf: ['parabolic', 'line']},
    button: {default: 'trackpad', oneOf: ['trackpad', 'trigger', 'grip', 'menu']},
    startEvents: {type: 'array'},
    endEvents: {type: 'array'},
    collisionEntities: {default: ''},
    hitEntity: {type: 'selector'},
    cameraRig: {type: 'selector'},
    teleportOrigin: {type: 'selector'},
    hitCylinderColor: {type: 'color', default: '#99ff99'},
    beforeHitCylinderColor: {type: 'color', default: '#7f3fbf'},
    hitCylinderRadius: {default: 0.25, min: 0},
    hitCylinderHeight: {default: 0.3, min: 0},
    interval: {default: 0},
    maxLength: {default: 10, min: 0, if: {type: ['line']}},
    curveNumberPoints: {default: 30, min: 2, if: {type: ['parabolic']}},
    curveLineWidth: {default: 0.025},
    curveHitColor: {type: 'color', default: '#99ff99'},
    curveMissColor: {type: 'color', default: '#ff0000'},
    curveShootingSpeed: {default: 5, min: 0, if: {type: ['parabolic']}},
    defaultPlaneSize: { default: 100 },
    landingNormal: {type: 'vec3', default: { x: 0, y: 1, z: 0 }},
    landingMaxAngle: {default: '45', min: 0, max: 360},
    drawIncrementally: {default: false},
    incrementalDrawMs: {default: 700},
    missOpacity: {default: 1.0},
    hitOpacity: {default: 1.0}
  },

  init: function () {
    var data = this.data;
    var el = this.el;
    var teleportEntity;
    var i;
    this.active = false;
    this.obj = el.object3D;
    this.hitPoint = new THREE.Vector3();
    this.rigWorldPosition = new THREE.Vector3();
    this.newRigWorldPosition = new THREE.Vector3();
    this.teleportEventDetail = {
      oldPosition: this.rigWorldPosition,
      newPosition: this.newRigWorldPosition,
      hitPoint: this.hitPoint
    };

    this.hit = false;
    this.prevCheckTime = undefined;
    this.prevHitHeight = 0;
    this.referenceNormal = new THREE.Vector3();
    this.curveMissColor = new THREE.Color();
    this.curveHitColor = new THREE.Color();
    this.raycaster = new THREE.Raycaster();
    this.collidedIndex = -1;

    // init raycastPoints by initial curveNumberPoints
    this.raycastPoints = Array.from(new Array(data.curveNumberPoints), () => new THREE.Vector3());
    this.defaultPlane = createDefaultPlane(this.data.defaultPlaneSize);
    this.defaultCollisionMeshes = [this.defaultPlane];

    teleportEntity = this.teleportEntity = document.createElement('a-entity');
    teleportEntity.classList.add('teleportRay');
    teleportEntity.setAttribute('visible', false);
    el.sceneEl.appendChild(this.teleportEntity);

    this.onButtonDown = this.onButtonDown.bind(this);
    this.onButtonUp = this.onButtonUp.bind(this);
    if (this.data.startEvents.length && this.data.endEvents.length) {

      for (i = 0; i < this.data.startEvents.length; i++) {
        el.addEventListener(this.data.startEvents[i], this.onButtonDown);
      }
      for (i = 0; i < this.data.endEvents.length; i++) {
        el.addEventListener(this.data.endEvents[i], this.onButtonUp);
      }
    } else {
      el.addEventListener(data.button + 'down', this.onButtonDown);
      el.addEventListener(data.button + 'up', this.onButtonUp);
    }

    this.queryCollisionEntities();
  },

  update: function (oldData) {
    var data = this.data;
    var diff = AFRAME.utils.diff(data, oldData);

    // Update normal.
    this.referenceNormal.copy(data.landingNormal);

    // Update colors.
    this.curveMissColor.set(data.curveMissColor);
    this.curveHitColor.set(data.curveHitColor);


    // Create or update line mesh.
    if (!this.line ||
        'curveLineWidth' in diff || 'curveNumberPoints' in diff || 'type' in diff) {

      this.line = createLine(data);
      this.line.material.opacity = this.data.hitOpacity;
      this.line.material.transparent = this.data.hitOpacity < 1;
      this.timeSinceDrawStart = 0;
      this.teleportEntity.setObject3D('mesh', this.line.mesh);
    }

    // Create or update hit entity.
    if (data.hitEntity) {
      this.hitEntity = data.hitEntity;
    } else if (!this.hitEntity || 'hitCylinderColor' in diff || 'hitCylinderHeight' in diff ||
               'hitCylinderRadius' in diff) {
      // Remove previous entity, create new entity (could be more performant).
      if (this.hitEntity) { this.hitEntity.parentNode.removeChild(this.hitEntity); }
      this.hitEntity = createHitEntity(data);
      this.el.sceneEl.appendChild(this.hitEntity);
    }
    this.hitEntity.setAttribute('visible', false);

    if ('collisionEntities' in diff) { this.queryCollisionEntities(); }
    if (!this.raycastPoints || 'curveNumberPoints' in diff) {
      this.raycastPoints = Array.from(new Array(data.curveNumberPoints), () => new THREE.Vector3());
    }
  },

  remove: function () {
    var el = this.el;
    var hitEntity = this.hitEntity;
    var teleportEntity = this.teleportEntity;

    if (hitEntity) { hitEntity.parentNode.removeChild(hitEntity); }
    if (teleportEntity) { teleportEntity.parentNode.removeChild(teleportEntity); }

    el.sceneEl.removeEventListener('child-attached', this.childAttachHandler);
    el.sceneEl.removeEventListener('child-detached', this.childDetachHandler);
  },

  tick: (function () {
    var p0 = new THREE.Vector3();
    var v0 = new THREE.Vector3();
    var g = -9.8;
    var a = new THREE.Vector3(0, g, 0);
    var next = new THREE.Vector3();
    var last = new THREE.Vector3();
    var quaternion = new THREE.Quaternion();
    var translation = new THREE.Vector3();
    var scale = new THREE.Vector3();
    var shootAngle = new THREE.Vector3();
    var lastNext = new THREE.Vector3();
    var auxDirection = new THREE.Vector3();
    var timeSinceDrawStart = 0;

    return function (time, delta) {
      if (!this.active) { return; }
      if (this.data.drawIncrementally && this.redrawLine){
        this.redrawLine = false;
        timeSinceDrawStart = 0;
      }
      timeSinceDrawStart += delta;
      this.timeSinceDrawStart = timeSinceDrawStart;
      if (this.timeSinceDrawStart > this.data.incrementalDrawMs) {
        this.timeSinceDrawStart = this.data.incrementalDrawMs;
      }
      // Only check for intersection if interval time has passed.
      if (this.prevCheckTime && (time - this.prevCheckTime < this.data.interval)) { return; }
      // Update check time.
      this.prevCheckTime = time;

      var matrixWorld = this.obj.matrixWorld;
      matrixWorld.decompose(translation, quaternion, scale);

      var direction = shootAngle.set(0, 0, -1)
        .applyQuaternion(quaternion).normalize();
      this.line.setDirection(auxDirection.copy(direction));
      this.obj.getWorldPosition(p0);

      last.copy(p0);

      // Set default status as non-hit
      this.teleportEntity.setAttribute('visible', true);
      this.hitEntity.setAttribute('visible', false);
      this.hit = false;
      this.collidedIndex = -1;
      this.setLineMaterial(this.hit);

      if (this.data.type === 'parabolic') {
        v0.copy(direction).multiplyScalar(this.data.curveShootingSpeed);
        this.lastDrawnIndex = 0;
        const numPoints = this.raycastPoints.length;
        const timeSegment = this.data.incrementalDrawMs / numPoints;
        for (let i = 0; i < numPoints; i++) {
          // t for parabolic requires in seconds instead of milliseconds.
          let t = i * timeSegment / 1000;
          parabolicCurve(p0, v0, a, t, next);
          this.raycastPoints[i].copy(next);
          // Update the raycaster with the length of the current segment last->next
          var dirLastNext = lastNext.copy(next).sub(last).normalize();
          this.raycaster.far = dirLastNext.length();
          this.raycaster.set(last, dirLastNext);
          last.copy(next);
          if (this.isMeshCollided()) {
            this.collidedIndex = i;
            this.hit = true;
            break;
          }
        }
      } else if (this.data.type === 'line') {
        next.copy(last).add(auxDirection.copy(direction).multiplyScalar(this.data.maxLength));
        this.raycaster.far = this.data.maxLength;
        this.raycaster.set(p0, direction);
        this.raycastPoints[0].copy(p0);
        this.raycastPoints[1].copy(next);
        if (this.isMeshCollided()) {
          this.collidedIndex = 1;
          this.hit = true;
        }
      }
      if (this.hit) {
        this.updateLineAndHitEntityByCollisions();
      }
      this.updateRaycastPoints();
      this.setLinePoints();
    };
  })(),

  /**
   * Run `querySelectorAll` for `collisionEntities` and maintain it with `child-attached`
   * and `child-detached` events.
   */
  queryCollisionEntities: function () {
    var collisionEntities;
    var data = this.data;
    var el = this.el;

    if (!data.collisionEntities) {
      this.collisionEntities = [];
      return;
    }

    collisionEntities = [].slice.call(el.sceneEl.querySelectorAll(data.collisionEntities));
    this.collisionEntities = collisionEntities;

    // Update entity list on attach.
    this.childAttachHandler = function childAttachHandler (evt) {
      if (!evt.detail.el.matches(data.collisionEntities)) { return; }
      collisionEntities.push(evt.detail.el);
    };
    el.sceneEl.addEventListener('child-attached', this.childAttachHandler);

    // Update entity list on detach.
    this.childDetachHandler = function childDetachHandler (evt) {
      var index;
      if (!evt.detail.el.matches(data.collisionEntities)) { return; }
      index = collisionEntities.indexOf(evt.detail.el);
      if (index === -1) { return; }
      collisionEntities.splice(index, 1);
    };
    el.sceneEl.addEventListener('child-detached', this.childDetachHandler);
  },

  onButtonDown: function () {
    this.active = true;
    this.redrawLine = true;
  },

  /**
   * Jump!
   */
  onButtonUp: (function () {
    const teleportOriginWorldPosition = new THREE.Vector3();
    const newRigLocalPosition = new THREE.Vector3();
    const newHandPosition = [new THREE.Vector3(), new THREE.Vector3()]; // Left and right
    const handPosition = new THREE.Vector3();

    return function (evt) {
      if (!this.active) { return; }

      // Hide the hit point and the curve
      this.active = false;
      this.hitEntity.setAttribute('visible', false);
      this.teleportEntity.setAttribute('visible', false);

      if (!this.hit) {
        // Button released but not hit point
        return;
      }

      // button released before the teleport animation finishes
      if (this.hit && this.timeSinceDrawStart < this.data.incrementalDrawMs) { return; }

      const rig = this.data.cameraRig || this.el.sceneEl.camera.el;
      rig.object3D.getWorldPosition(this.rigWorldPosition);
      this.newRigWorldPosition.copy(this.hitPoint);

      // If a teleportOrigin exists, offset the rig such that the teleportOrigin is above the hitPoint
      const teleportOrigin = this.data.teleportOrigin;
      if (teleportOrigin) {
        teleportOrigin.object3D.getWorldPosition(teleportOriginWorldPosition);
        this.newRigWorldPosition.sub(teleportOriginWorldPosition).add(this.rigWorldPosition);
      }

      // Always keep the rig at the same offset off the ground after teleporting
      this.newRigWorldPosition.y = this.rigWorldPosition.y + this.hitPoint.y - this.prevHitHeight;
      this.prevHitHeight = this.hitPoint.y;

      // Finally update the rigs position
      newRigLocalPosition.copy(this.newRigWorldPosition);
      if (rig.object3D.parent) {
        rig.object3D.parent.worldToLocal(newRigLocalPosition);
      }
      rig.setAttribute('position', newRigLocalPosition);

      // If a rig was not explicitly declared, look for hands and mvoe them proportionally as well
      if (!this.data.cameraRig) {
        var hands = document.querySelectorAll('a-entity[tracked-controls]');
        for (var i = 0; i < hands.length; i++) {
          hands[i].object3D.getWorldPosition(handPosition);

          // diff = rigWorldPosition - handPosition
          // newPos = newRigWorldPosition - diff
          newHandPosition[i].copy(this.newRigWorldPosition).sub(this.rigWorldPosition).add(handPosition);
          hands[i].setAttribute('position', newHandPosition[i]);
        }
      }

      this.el.emit('teleported', this.teleportEventDetail);
    };
  })(),

  isValidNormalsAngle: function (collisionNormal) {
    var angleNormals = this.referenceNormal.angleTo(collisionNormal);
    return (THREE.Math.RAD2DEG * angleNormals <= this.data.landingMaxAngle);
  },

  /**
   * Check for the raycaster intersection
   * isMeshCollided() returns true/false
   * based on whether the mesh collides with the raycaster
   * @returns {boolean} true, if there's an intersection
  */
  isMeshCollided: function () {
    var meshes;
    if (!this.data.collisionEntities) {
      meshes = this.defaultCollisionMeshes;
    } else {
      meshes = this.collisionEntities.map(function (entity) {
        return entity.getObject3D('mesh');
      }).filter(function (n) { return n; });
      meshes = meshes.length ? meshes : this.defaultCollisionMeshes;
    }

    var intersects = this.raycaster.intersectObjects(meshes, true);
    if (intersects.length > 0 && !this.hit &&
        this.isValidNormalsAngle(intersects[0].face.normal)) {
      // save the hit point and then return true
      var point = intersects[0].point;
      this.hitPoint.copy(intersects[0].point);
      return true;
    }
    return false;
  },

  /**
   * Set the line materials for rendering
   * @param {boolean} isCollided to determine the hit/miss material of the line
  */
  setLineMaterial: function (isCollided) {
    const color = isCollided ? this.curveHitColor : this.curveMissColor;
    const opacity = isCollided ? this.data.hitOpacity : this.data.missOpacity;
    const transparent = isCollided ? (this.data.hitOpacity < 1) : (this.data.missOpacity < 1);
    this.line.material.color.set(color);
    this.line.material.opacity = opacity;
    this.line.material.transparent = transparent;
  },

  /**
   * Set line points for rendering
   *
  */
  setLinePoints: function () {
    const numPoints = this.raycastPoints.length;
    for (let i = 0; i < numPoints; i++) {
      this.line.setPoint(i, this.raycastPoints[i]);
    }
  },

  /*
   * update raycast points by the ratio of the parabolic line we ar gonna draw.
  */
  updateRaycastPoints: function () {
    const numPoints = this.raycastPoints.length;
    let drawTime = 1;
    let ratio = 1;
    if (this.hit) {
      this.raycastPoints[this.collidedIndex].copy(this.hitPoint);
    }
    let endOfLineIndex = (this.hit) ? this.collidedIndex : numPoints;
    if (this.data.drawIncrementally) {
      drawTime = this.timeSinceDrawStart;
      ratio = (drawTime / this.data.incrementalDrawMs);
    }
    let endIndexOfDrawLine = Math.round(ratio * endOfLineIndex);
    for (let i = endIndexOfDrawLine; i < numPoints; i++) {
        this.raycastPoints[i].copy(this.raycastPoints[endIndexOfDrawLine]);
    }
  },

  /**
   * update hitEntity & line material while there's a collision.
   * only called while there's a collision
  */
  updateLineAndHitEntityByCollisions: function () {
    this.setLineMaterial(this.hit);
    this.hitEntity.setAttribute('position', this.hitPoint);
    let isLineHit = this.timeSinceDrawStart >= this.data.incrementalDrawMs;
    this.updateHitEntityColor(isLineHit);
    this.hitEntity.setAttribute('visible', true);
  },

  /**
   * update the color of hit entity for three states ()
  */
  updateHitEntityColor : function (isLineHit) {
    let color = (isLineHit) ? this.data.hitCylinderColor : this.data.beforeHitCylinderColor;
    let children = this.hitEntity.querySelectorAll('a-entity');
    for (let i = 0; i < children.length; i++) {
      children[i].setAttribute('material', 'color', color);
    }
  }
});


function createLine (data) {
  var numPoints = data.type === 'line' ? 2 : data.curveNumberPoints;
  return new RayCurve(numPoints, data.curveLineWidth);
}

/**
 * Create mesh to represent the area of intersection.
 * Default to a combination of torus and cylinder.
 */
function createHitEntity (data) {
  var cylinder;
  var hitEntity;
  var torus;

  // Parent.
  hitEntity = document.createElement('a-entity');
  hitEntity.className = 'hitEntity';

  // Torus.
  torus = document.createElement('a-entity');
  torus.setAttribute('geometry', {
    primitive: 'torus',
    radius: data.hitCylinderRadius,
    radiusTubular: 0.01
  });
  torus.setAttribute('rotation', {x: 90, y: 0, z: 0});
  torus.setAttribute('material', {
    shader: 'flat',
    color: data.hitCylinderColor,
    side: 'double',
    depthTest: false
  });
  hitEntity.appendChild(torus);

  // Cylinder.
  cylinder = document.createElement('a-entity');
  cylinder.setAttribute('position', {x: 0, y: data.hitCylinderHeight / 2, z: 0});
  cylinder.setAttribute('geometry', {
    primitive: 'cylinder',
    segmentsHeight: 1,
    radius: data.hitCylinderRadius,
    height: data.hitCylinderHeight,
    openEnded: true
  });
  cylinder.setAttribute('material', {
    shader: 'flat',
    color: data.hitCylinderColor,
    side: 'double',
    src: cylinderTexture,
    transparent: true,
    depthTest: false
  });
  hitEntity.appendChild(cylinder);

  return hitEntity;
}

function createDefaultPlane (size) {
  var geometry;
  var material;

  geometry = new THREE.PlaneBufferGeometry(100, 100);
  geometry.rotateX(-Math.PI / 2);
  material = new THREE.MeshBasicMaterial({color: 0xffff00});
  return new THREE.Mesh(geometry, material);
}
