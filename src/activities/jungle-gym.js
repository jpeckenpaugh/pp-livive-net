/**
 * Back-compat entry point for the original single-course module.
 *
 * All courses now share one implementation in `./platformer.js`; everything
 * funnels through the same factory so a caller that still imports this path
 * cannot accidentally run a stale copy.
 */
export {
  ACTIVITIES,
  DEFAULT_THEME,
  CourseActivity as JungleGymActivity,
  activityDefinition,
  activityList,
  bestMsFor,
  buildCourse,
  buildGhostPath,
  createActivity,
  createActivity as createJungleGym,
  createRun,
  formatActivityTime,
  ghostJumpTimes,
  ghostXAt,
  ghostYAt,
  isActivityEnabled,
  outcomeForTime,
  parTimeFor,
  recordActivityAttempt,
  rewardForActivity,
  stepCamera,
  stepRun,
  themeFor,
  validateActivityDefinition
} from './platformer.js';
