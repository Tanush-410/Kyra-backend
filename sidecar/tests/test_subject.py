"""Several people in view: the nearest one is the subject, and stays the subject from frame to frame."""

from types import SimpleNamespace

import numpy as np

from kyra_sidecar.perception import SubjectTracker, build_analysis, closest_face, describe_person
from tests.test_upgrades import loop_for_test

W, H = 960, 540


def person(cx: float, size: float, facing: bool = True) -> list:
    """Pose landmarks of a standing person centred at cx, `size` = shoulder width as a fraction of the frame width."""
    points = np.zeros((33, 4))
    points[:, 3] = 1.0
    half = size / 2
    top = 0.15
    points[0, :2] = [cx, top]                                   # nose
    points[[2, 5], :2] = [[cx - half * 0.2, top - 0.02], [cx + half * 0.2, top - 0.02]]  # eyes
    points[[7, 8], :2] = [[cx - half * 0.38, top], [cx + half * 0.38, top]]              # ears
    points[[11, 12], :2] = [[cx - half, top + size * 1.0], [cx + half, top + size * 1.0]]
    points[[23, 24], :2] = [[cx - half * 0.7, top + size * 2.2], [cx + half * 0.7, top + size * 2.2]]
    points[[27, 28], :2] = [[cx - half * 0.6, 0.95], [cx + half * 0.6, 0.95]]
    points[[29, 30, 31, 32], :2] = [cx, 0.96]
    placed = [0, 2, 5, 7, 8, 11, 12, 23, 24, 27, 28, 29, 30, 31, 32]
    points[[i for i in range(33) if i not in placed], 3] = 0.0  # landmarks not drawn are not visible
    if not facing:
        points[[0, 2, 5], 3] = 0.1
    return [SimpleNamespace(x=x, y=y, z=z, visibility=v) for x, y, z, v in points]


def pose_result(*people):
    return SimpleNamespace(pose_landmarks=list(people), pose_world_landmarks=None, segmentation_masks=None)


def candidates(*people):
    return [describe_person(np.array([[lm.x, lm.y, lm.z, lm.visibility] for lm in p]), W, H) for p in people]


def test_nearest_person_is_the_subject_and_only_their_face_is_meshed():
    far, near = person(0.5, 0.08), person(0.3, 0.16)
    meshed = []

    def find_face(rgb, landmarks):
        meshed.append(landmarks[0, 0])
        return None

    analysis = build_analysis(np.zeros((H, W, 3), np.uint8), pose_result(far, near), find_face)
    assert analysis.landmarks[0, 0] == 0.3, "the larger (nearer) person, even off-centre"
    assert meshed == [0.3]
    assert 0.4 < analysis.second_person_ratio < 0.6


def test_someone_facing_the_mirror_beats_a_passer_by_of_the_same_size():
    passer, visitor = candidates(person(0.5, 0.12, facing=False), person(0.55, 0.12))
    assert visitor["score"] > passer["score"]


def test_subject_holds_against_a_slightly_nearer_person_and_yields_to_a_clearly_nearer_one():
    tracker = SubjectTracker(switch_frames=5)
    visitor = person(0.5, 0.12)
    index, confirmed = tracker.choose(candidates(visitor))
    first_id = tracker.subject_id
    assert (index, confirmed) == (0, True)

    for _ in range(10):  # 10% nearer: not enough to take over
        assert tracker.choose(candidates(visitor, person(0.2, 0.132))) == (0, True)
    assert tracker.subject_id == first_id

    picks = [tracker.choose(candidates(visitor, person(0.2, 0.2)))[0] for _ in range(5)]
    assert picks == [0, 0, 0, 0, 1], "takes over only after five frames in a row"
    assert tracker.subject_id == first_id + 1


def test_briefly_losing_the_subject_does_not_hand_over_the_visit():
    tracker = SubjectTracker(grace_frames=4)
    visitor, bystander = person(0.5, 0.12), person(0.15, 0.09)
    tracker.choose(candidates(visitor, bystander))
    first_id = tracker.subject_id
    for _ in range(3):  # the pose model misses the visitor for three frames
        _, confirmed = tracker.choose(candidates(bystander))
        assert confirmed is False, "frames without the subject are not measured"
    assert tracker.choose(candidates(visitor, bystander)) == (0, True)
    assert tracker.subject_id == first_id


def test_a_new_person_after_the_visitor_leaves_is_a_new_subject():
    tracker = SubjectTracker(grace_frames=2)
    tracker.choose(candidates(person(0.5, 0.12)))
    first_id = tracker.subject_id
    for _ in range(3):
        tracker.no_people()
    tracker.reset()  # the camera calls this once nobody has been seen for ABSENT_AFTER_MS
    tracker.choose(candidates(person(0.5, 0.12)))
    assert tracker.subject_id == first_id + 1


def test_walking_up_to_the_screen_alone_never_changes_the_visitor():
    # The bug seen on 7 Nov 2026: stepping closer to look at the result counted as a new person and
    # ended the session. Alone in view, the visitor stays the visitor through any move or dropout.
    tracker = SubjectTracker()
    tracker.choose(candidates(person(0.5, 0.08)))   # head to toe, far from the camera
    first_id = tracker.subject_id
    for size, cx in [(0.1, 0.52), (0.14, 0.6), (0.2, 0.7), (0.3, 0.75)]:   # walks up and to the side
        assert tracker.choose(candidates(person(cx, size))) == (0, True)
    for _ in range(20):                               # too close: the pose model loses the body
        tracker.no_people()
    assert tracker.choose(candidates(person(0.3, 0.35))) == (0, True)
    assert tracker.subject_id == first_id


def test_face_mesh_is_taken_from_the_face_on_this_persons_nose():
    mine, neighbour = np.full((478, 2), 0.5), np.full((478, 2), 0.7)
    assert closest_face([neighbour, mine], np.array([0.51, 0.5]), 0.05) is mine
    assert closest_face([neighbour], np.array([0.5, 0.5]), 0.05) is None


def test_camera_drops_the_previous_persons_samples_when_the_subject_changes():
    from collections import deque
    from threading import Lock

    from kyra_sidecar.lighting import LightSmoother

    loop, events = loop_for_test()
    loop._lock, loop._subject_id, loop._present = Lock(), None, True
    loop._skin, loop._best_face, loop._light = deque([{"lab": [60, 12, 20]}]), {"score": 1}, LightSmoother()
    loop._ready_since, loop._ready_frames, loop._early_profile_key = 1.0, deque([1]), ("warm",)

    loop._track_subject(SimpleNamespace(extras={"subjectId": 1}))
    assert events == [] and not loop._skin, "the first subject is not a replacement"
    loop._skin.append({"lab": [60, 12, 20]})
    loop._track_subject(SimpleNamespace(extras={"subjectId": 1}))
    assert len(loop._skin) == 1
    loop._track_subject(SimpleNamespace(extras={"subjectId": 2}))
    assert not loop._skin and loop._best_face is None and loop._early_profile_key is None
    assert events == [{"type": "subject", "subjectId": 2, "replaced": True}]


def test_one_body_detected_twice_counts_as_one_person():
    # Seen live: the pose model reported a phantom "second person" overlapping the visitor in 3 of 96 frames.
    visitor, duplicate, other = person(0.5, 0.12), person(0.51, 0.118), person(0.15, 0.1)
    analysis = build_analysis(np.zeros((H, W, 3), np.uint8), pose_result(visitor, duplicate), lambda *_: None)
    assert analysis.person_count == 1 and analysis.second_person_ratio == 0.0
    two = build_analysis(np.zeros((H, W, 3), np.uint8), pose_result(visitor, duplicate, other), lambda *_: None)
    assert two.person_count == 2, "a real second person is still counted"
