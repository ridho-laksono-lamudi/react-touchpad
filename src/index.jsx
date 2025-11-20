import React, { Children, cloneElement, Component, createRef } from 'react';
import PropTypes from 'prop-types';
import makeTween from 'raf-tween';
import makeNumberInterpolator from 'raf-tween/lib/makeNumberInterpolator';
import makeOmitter from 'react-omit-own-props';
import applyBounds from './applyBounds';
import calcOffset from './calcOffset';
import compareOffset from './compareOffset';
import defaultTimingFunc from './defaultTimingFunc';
import define from './define';
import getDistance from './getDistance';
import getDirection from './getDirection';
import getTime from './getTime';
import getNextOffset from './getNextOffset';
import interpolateOffset from './interpolateOffset';
import modify from './modify';
import prevent from './prevent';

const DEFAULT_STATE = {
  currentX: 0,
  currentY: 0,
  firstX: 0,
  firstY: 0,
};

const PROP_TYPES = {
  bounds: PropTypes.oneOfType([
    PropTypes.func,
    PropTypes.shape({
      left: PropTypes.number,
      right: PropTypes.number,
      top: PropTypes.number,
      bottom: PropTypes.number,
    }),
  ]),
  children: PropTypes.node,
  defaultX: PropTypes.number,
  defaultY: PropTypes.number,
  disabled: PropTypes.bool,
  ease: PropTypes.func,
  elasticity: PropTypes.number,
  element: PropTypes.string,
  friction: PropTypes.number,
  holdDelay: PropTypes.number,
  lockX: PropTypes.bool,
  lockY: PropTypes.bool,
  onComplete: PropTypes.func,
  onHold: PropTypes.func,
  onStart: PropTypes.func,
  onStop: PropTypes.func,
  onUpdate: PropTypes.func,
  windage: PropTypes.number,
  x: PropTypes.number,
  y: PropTypes.number,
};

const DEFAULT_PROPS = {
  bounds: {},
  children: null,
  defaultX: 0,
  defaultY: 0,
  disabled: false,
  ease: defaultTimingFunc,
  elasticity: 0.6,
  element: 'div',
  friction: 0.006,
  holdDelay: 604,
  lockX: false,
  lockY: false,
  onComplete() {},
  onHold() {},
  onStart() {},
  onStop() {},
  onUpdate() {},
  windage: 0.064,
  x: null,
  y: null,
};

const omit = makeOmitter(PROP_TYPES);

export default class ReactTouchpad extends Component {
  static propTypes = PROP_TYPES;
  static defaultProps = DEFAULT_PROPS;

  constructor(props, context) {
    super(props, context);
    this.state = {
      ...DEFAULT_STATE,
      lastX: typeof x === 'number' ? props.x : props.defaultX,
      lastY: typeof y === 'number' ? props.y : props.defaultY,
    };
    this.replaceState = this.replaceState.bind(this);
    this.tween = makeTween({
      interpolator: (a, b) => i => ({
        x: makeNumberInterpolator(a.x, b.x)(i),
        y: makeNumberInterpolator(a.y, b.y)(i),
      }),
      ease: this.props.ease,
      onUpdate: this.replaceState,
    });
    this.direction = null;
    this.isMoving = false;
    this.direction = null;
    this.isMoving = false;
    this.node = createRef();
    this.trackingPoints = [];
    this.emitStop = this.props.onStop;
  }

  componentDidMount() {
    window.addEventListener('mousemove', this.handleMove);
    window.addEventListener('mouseup', this.handleEnd);
    window.addEventListener('touchmove', this.preventMove, { passive: false, canselable: true });
  }
  componentDidUpdate(prevProps, prevState) {
    const prevOffset = calcOffset(prevState);
    const currentOffset = calcOffset(this.state);
    if (compareOffset(prevOffset, currentOffset)) return;
    this.props.onUpdate(this.childProps, this.replaceState);
  }
  componentWillUnmount() {
    window.removeEventListener('mousemove', this.handleMove);
    window.addEventListener('mouseup', this.handleEnd);
    window.removeEventListener('touchmove', this.preventMove);
    this.stopAllTransitions();
  }

  get isDisabled() {
    return this.props.disabled;
  }
  get bounds() {
    const { bounds } = this.props;
    const { top, left, bottom, right } =
      typeof bounds === 'function' && this.node.current ? bounds(this.node.current) : bounds;
    const { x, y } = this.offset;
    return {
      top: define(top, y),
      left: define(left, x),
      bottom: define(bottom, y),
      right: define(right, x),
    };
  }
  get childProps() {
    const { bounds, offset } = this;
    const { elasticity } = this.props;
    return interpolateOffset(offset, bounds, elasticity);
  }
  get fitsBounds() {
    const { bounds, offset } = this;
    const { x, y } = applyBounds(offset, bounds);
    return x === offset.x && y === offset.y;
  }
  get offset() {
    return calcOffset(this.state);
  }

  emitComplete = () => this.props.onComplete(this.replaceState);
  emitHold = modifiedEvent => {
    if (!this.isMoving) return;
    this.props.onHold(modifiedEvent, this.replaceState);
  };

  handleStart = event => {
    if (this.isDisabled) return;
    const modifiedEvent = modify(event);
    event.stopPropagation();
    this.unTween();
    this.isMoving = true;
    this.trackingPoints = [];
    this.updateState(modifiedEvent);
    this.promptHold(modifiedEvent);
    this.props.onStart(modifiedEvent);
  };
  handleMove = event => {
    if (!this.isMoving) return;
    const modifiedEvent = modify(event);
    if (!this.direction) this.direction = getDirection(modifiedEvent, this.trackingPoints);
    this.updateState(modifiedEvent);
    this.track(modifiedEvent.x, modifiedEvent.y);
    this.unHold();
  };
  handleWheel = event => {
    if (this.isDisabled) return;
    event.preventDefault();
    const { deltaX: x, deltaY: y } = event;
    this.patchState({ x, y });
    this.propmptFitBounds(600);
    this.unHold();
  };
  handleEnd = () => {
    if (!this.isMoving) return;
    this.direction = null;
    this.isMoving = false;
    this.fixState();
    this.createTween(!this.fitsBounds);
    this.emitStop(this.replaceState);
  };

  makeFitBounds = prevDuration => () => {
    const { bounds } = this;
    const { ease, elasticity } = this.props;
    const nextOffset = applyBounds(this.offset, bounds);
    const duration = prevDuration ** elasticity;
    this.tweenTo(nextOffset, { duration, ease, onComplete: this.emitComplete });
  };
  preventMove = event => {
    const { direction } = this;
    const { lockX, lockY } = this.props;
    if ((lockX && direction === 'horizontal') || (lockY && direction === 'vertical'))
      event.preventDefault();
  };
  propmptFitBounds(duration) {
    this.unfitBounds();
    this.fitBoundstimeout = setTimeout(this.makeFitBounds(duration), 100);
  }
  unfitBounds() {
    clearTimeout(this.fitBoundstimeout);
  }

  promptHold(modifiedEvent) {
    const { holdDelay } = this.props;
    this.holdTimeout = setTimeout(() => this.emitHold(modifiedEvent), holdDelay);
  }
  unHold() {
    clearTimeout(this.holdTimeout);
  }

  fixState() {
    const { x: lastX, y: lastY } = this.offset;
    this.setState({ ...DEFAULT_STATE, lastX, lastY });
  }
  patchState({ x, y }) {
    this.setState(({ lastX, lastY }) => ({
      lastX: lastX - x,
      lastY: lastY - y,
    }));
  }
  replaceState({ x, y }, stopAllTransitions) {
    if (stopAllTransitions) this.stopAllTransitions();
    this.setState({ lastX: x, lastY: y });
  }
  updateState({ x, y }) {
    if (this.isDisabled) return;
    this.setState(({ firstX, firstY }) => ({
      firstX: define(firstX, x, DEFAULT_STATE.firstX),
      firstY: define(firstY, y, DEFAULT_STATE.firstY),
      currentX: x,
      currentY: y,
    }));
  }

  createTween(shouldBounce) {
    const points = [...this.trackingPoints];
    if (points.length < 2) return;
    points.splice(1, points.length - 2);

    const { friction, windage } = this.props;

    const distance = getDistance(points);
    const time = getTime(points);
    const impulse = time * windage;
    const duration = impulse / friction;

    const bounce = this.makeFitBounds(duration);
    const nextOffset = getNextOffset(this.offset, distance, impulse);

    if (shouldBounce) bounce();
    else this.tweenTo(nextOffset, { duration, onComplete: bounce });
  }
  tweenTo(nextOffset, options) {
    this.unTween();
    this.cancelTransition = this.tween(this.offset, nextOffset, options);
  }
  unTween() {
    if (this.cancelTransition) this.cancelTransition();
  }

  stopAllTransitions() {
    this.unHold();
    this.unfitBounds();
    this.unTween();
  }
  track(x, y) {
    const ts = Date.now();
    const nextPoints = this.trackingPoints.filter(point => ts - point.ts < 100);
    this.trackingPoints = nextPoints;
    this.trackingPoints.push({ x, y, ts });
  }

  render() {
    const { element: Element } = this.props;
    const { childProps } = this;
    return (
      <Element
        {...omit(this.props)}
        onDragStart={prevent}
        onContextMenu={prevent}
        onMouseDown={this.handleStart}
        onWheel={this.handleWheel}
        onTouchStart={this.handleStart}
        onTouchMove={this.handleMove}
        onTouchEnd={this.handleEnd}
        onTouchCancel={this.handleEnd}
        ref={this.node}
      >
        {Children.map(this.props.children, Child => cloneElement(Child, childProps))}
      </Element>
    );
  }
}
