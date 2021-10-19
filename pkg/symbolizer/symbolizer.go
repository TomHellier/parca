// Copyright 2021 The Parca Authors
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package symbolizer

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/go-kit/log"
	"github.com/go-kit/log/level"
	"github.com/google/pprof/profile"
	"github.com/hashicorp/go-multierror"
	"github.com/parca-dev/parca/pkg/debuginfo"
	"github.com/parca-dev/parca/pkg/runutil"
	"github.com/parca-dev/parca/pkg/storage/metastore"
)

type Symbolizer struct {
	logger    log.Logger
	locations metastore.LocationStore
	debugInfo *debuginfo.Store

	attemptThreshold int
	attempts         map[string]map[uint64]int
	failed           map[string]map[uint64]struct{}
}

func NewSymbolizer(logger log.Logger, loc metastore.LocationStore, info *debuginfo.Store, attemptThreshold int) *Symbolizer {
	return &Symbolizer{
		logger:    log.With(logger, "component", "symbolizer"),
		locations: loc,
		debugInfo: info,

		attemptThreshold: attemptThreshold,
		attempts:         map[string]map[uint64]int{},
		failed:           map[string]map[uint64]struct{}{},
	}
}

func (s *Symbolizer) Run(ctx context.Context, interval time.Duration) error {
	return runutil.Repeat(interval, ctx.Done(), func() error {
		locations, err := s.locations.GetSymbolizableLocations(ctx)
		if err != nil {
			return err
		}
		if len(locations) == 0 {
			// Nothing to symbolize.
			return nil
		}

		err = s.symbolize(ctx, locations)
		if err != nil {
			level.Error(s.logger).Log("msg", "symbolization attempt failed", "err", err)
		}
		return nil
	})
}

func (s *Symbolizer) symbolize(ctx context.Context, locations []*profile.Location) error {
	// Aggregate locations per mapping to get prepared for batch request.
	mappings := map[string]*profile.Mapping{}
	mappingLocations := map[string][]*profile.Location{}
	for _, loc := range locations {
		// If Mapping or Mapping.BuildID is empty, we cannot associate an object file with functions.
		if loc.Mapping == nil || len(loc.Mapping.BuildID) == 0 || loc.Mapping.Unsymbolizable() {
			level.Debug(s.logger).Log("msg", "mapping of location is empty, skipping")
			continue
		}
		// Already symbolized!
		if len(loc.Line) > 0 {
			level.Debug(s.logger).Log("msg", "location already symbolized, skipping")
			continue
		}
		// Check if we already attempt to symbolize this location and failed.
		if _, failedBefore := s.failed[loc.Mapping.BuildID][loc.Address]; failedBefore {
			level.Debug(s.logger).Log("msg", "location already had been attempted to be symbolized and failed, skipping")
			continue
		}
		mappings[loc.Mapping.BuildID] = loc.Mapping
		mappingLocations[loc.Mapping.BuildID] = append(mappingLocations[loc.Mapping.BuildID], loc)
	}

	var result *multierror.Error
	for buildID, mapping := range mappings {
		level.Debug(s.logger).Log("msg", "storage symbolization request started", "buildid", buildID)
		symbolizedLocations, err := s.debugInfo.Symbolize(ctx, mapping, mappingLocations[buildID]...)
		if err != nil {
			// It's ok if we don't have the symbols for given BuildID, it happens too often.
			if errors.Is(err, debuginfo.ErrDebugInfoNotFound) {
				level.Debug(s.logger).Log("msg", "failed to find the debug info in storage", "buildid", buildID)
				continue
			}
			result = multierror.Append(result, fmt.Errorf("storage symbolization request failed: %w", err))
			continue
		}
		level.Debug(s.logger).Log("msg", "storage symbolization request done", "buildid", buildID)

		for loc, lines := range symbolizedLocations {
			if len(lines) == 0 {
				if prev, ok := s.attempts[buildID][loc.Address]; ok {
					prev++
					if prev >= s.attemptThreshold {
						if _, ok := s.failed[buildID]; !ok {
							s.failed[buildID] = map[uint64]struct{}{}
						}
						s.failed[buildID][loc.Address] = struct{}{}
						delete(s.attempts[buildID], loc.Address)
					} else {
						s.attempts[buildID][loc.Address] = prev
					}
					continue
				}
				// First failed attempt
				if _, ok := s.attempts[buildID]; !ok {
					s.attempts[buildID] = map[uint64]int{}
				}
				s.attempts[buildID][loc.Address] = 1
				continue
			}

			loc.Line = lines
			// Only creates lines for given location.
			if err := s.locations.Symbolize(ctx, loc); err != nil {
				result = multierror.Append(result, fmt.Errorf("failed to update location %d: %w", loc.ID, err))
				continue
			}
		}
	}

	return result.ErrorOrNil()
}
