document.addEventListener("DOMContentLoaded", function () {
    const canvas = document.getElementById('commitGraph');
    const ctx = canvas?.getContext('2d');

    if (!canvas || !ctx) {
        console.error("Canvas element is missing.");
        return;
    }

    const statusText = document.getElementById('status-text');
    const commitButton = document.getElementById('commitButton');
    const currentBranchLabel = document.getElementById('current-branch');
    const previousBranchLabel = document.getElementById('previous-branch');
    const commitList = document.getElementById('commitList');
    const stagingList = document.getElementById('stagingList');

    // Track checkbox states globally
    let checkboxState = {};

    function updateStatus(message) {
        if (statusText) statusText.textContent = message;
    }

    function fetchState() {
        fetch('/state')
            .then(response => response.json())
            .then(state => {
                console.log("Fetched state:", state); // Debugging: Log the fetched state
                if (!state) {
                    console.error("Invalid state received:", state);
                    return;
                }
    
                adjustCanvasSize(state);
                drawVisualization(state);
                updateBranch(state);
                updateCommitHistory(state.commits); // Pass the full commits array
                updateCommitButton(state.staging_area);
                updateStagingArea(state.staging_area);
    
                // Populate branch selector
                const branchSelector = document.getElementById('branchSelector');
                if (branchSelector) {
                    branchSelector.innerHTML = ""; // Clear existing options
                    Object.keys(state.branches).forEach(branch => {
                        const option = document.createElement('option');
                        option.value = branch;
                        option.textContent = branch;
                        if (branch === state.current_branch) {
                            option.selected = true; // Select the current branch
                        }
                        branchSelector.appendChild(option);
                    });
                }
            })
            .catch(err => console.error("Error fetching state:", err));
    }

    function updateBranch(state) {
        if (!state) return;

        // Update the current branch label
        if (currentBranchLabel) {
            currentBranchLabel.textContent = state.current_branch || "main";
        }

        // Update the previous branch label
        if (previousBranchLabel) {
            previousBranchLabel.textContent = state.previous_branch || "None";
        }
    }

    function switchBranch() {
        const branchSelector = document.getElementById('branchSelector');
        const targetBranch = branchSelector?.value;
    
        if (!targetBranch) {
            updateStatus("Error: Please select a branch to switch to.");
            return;
        }
    
        fetch('/switch_branch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target_branch: targetBranch })
        })
            .then(response => response.json())
            .then(data => {
                updateStatus(data.message);
                fetchState(); // Refresh the state to reflect the new branch
            })
            .catch(err => {
                console.error("Error switching branch:", err);
                updateStatus("Error: Failed to switch branch.");
            });
    }

    function createBranch() {
        const branchName = document.getElementById('branchName')?.value;
        if (!branchName) {
            updateStatus("Error: Branch name is required");
            return;
        }

        fetch('/branch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ branch_name: branchName })
        })
            .then(response => response.json())
            .then(data => {
                updateStatus(data.message);
                fetchState(); // Refresh the state to reflect the new branch
            })
            .catch(err => {
                console.error("Error creating branch:", err);
                updateStatus("Error: Failed to create branch");
            });
    }

    function addFile() {
        const filename = document.getElementById('filename')?.value;
        const content = document.getElementById('content')?.value;
        if (!filename || !content) {
            updateStatus("Error: Filename and content are required");
            return;
        }
        fetch('/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename, content })
        })
            .then(response => response.json())
            .then(data => {
                console.log("Add response:", data);
                updateStatus(data.message);
                fetchState();
            })
            .catch(err => {
                console.error("Error adding file:", err);
                updateStatus("Error: Failed to add file");
            });
    }

    function updateStagingArea(stagingArea) {
        if (!stagingList) return;
    
        console.log("Updating staging area with:", stagingArea);
    
        // Save current checkbox states before clearing
        const checkboxState = {};
        document.querySelectorAll(".staged-file input").forEach(input => {
            checkboxState[input.value] = input.checked;
        });
    
        stagingList.innerHTML = "";
        if (!stagingArea || Object.keys(stagingArea).length === 0) {
            stagingList.innerHTML = "<li class='text-gray-500'>No files staged</li>";
            return;
        }
    
        Object.keys(stagingArea).forEach(filename => {
            const li = document.createElement("li");
            li.classList.add("staged-file", "p-2", "bg-gray-200", "dark:bg-gray-600", "rounded-lg", "my-1", "flex", "items-center");
    
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.value = filename;
            checkbox.classList.add("mr-2");
    
            // Restore previous state if exists, otherwise default to unchecked
            checkbox.checked = checkboxState[filename] !== undefined ? checkboxState[filename] : false;
    
            const label = document.createElement("span");
            label.textContent = filename;
    
            li.appendChild(checkbox);
            li.appendChild(label);
            stagingList.appendChild(li);
        });
    }

    function commit() {
        const message = document.getElementById('commitMessage')?.value;
        if (!message) {
            updateStatus("Error: Commit message is required");
            return;
        }
    
        const selectedFiles = [...document.querySelectorAll(".staged-file input:checked")]
            .map(input => input.value);
    
        if (selectedFiles.length === 0) {
            updateStatus("Error: Select at least one file to commit");
            return;
        }
    
        fetch('/commit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message, committed_files: selectedFiles })
        })
            .then(response => response.json())
            .then(data => {
                if (data.message) {
                    updateStatus(data.message);
                }
                if (data.state) {
                    fetchState(); // Refresh the state to update the staging area and commit history
                }
            })
            .catch(err => {
                console.error("Error committing:", err);
                updateStatus("Error: Failed to commit files.");
            });
    }


    function updateCommitHistory(commits) {
        if (!commitList) return;
        commitList.innerHTML = "";
    
        if (!commits || commits.length === 0) {
            commitList.innerHTML = "<li class='text-gray-500'>No commits yet</li>";
            return;
        }
    
        commits
            .filter(commit => commit.branch === currentBranchLabel.textContent) // Filter commits for the current branch
            .forEach(commit => {
                if (!commit || !commit.id || !commit.message) {
                    console.error("Invalid commit object:", commit);
                    return; // Skip invalid commit objects
                }
    
                const li = document.createElement("li");
                li.textContent = `${commit.id.slice(0, 7)} - ${commit.message}`;
                li.classList.add("p-2", "bg-gray-200", "dark:bg-gray-600", "rounded-lg", "my-1");
                commitList.appendChild(li);
            });
    }


    function updateCommitButton(stagingArea) {
        if (!commitButton) return;
        const hasFiles = Object.keys(stagingArea || {}).length > 0;
        commitButton.disabled = !hasFiles;
        commitButton.classList.toggle("opacity-50", !hasFiles);
    }

    let commitPositions = {};
    let commitDetails = {};

    function drawVisualization(state) {
        if (!state) return;
    
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        commitPositions = {};
        commitDetails = {};
    
        const branchNames = Object.keys(state.branches || {});
        const currentBranch = state.current_branch;
        const commits = state.commits || [];
        const nodeRadius = 20;
        const verticalSpacing = 100;
        const branchSpacing = canvas.width / (branchNames.length + 1);
    
        // Define colors for branches
        const branchColors = branchNames.reduce((colors, branch, index) => {
            colors[branch] = `hsl(${index * 60}, 70%, 50%)`; // Assign a unique color to each branch
            return colors;
        }, {});
    
        // Draw branch names at the top
        branchNames.forEach((branch, index) => {
            const x = branchSpacing * (index + 1);
            ctx.fillStyle = branchColors[branch];
            ctx.font = "bold 14px Arial";
            ctx.textAlign = "center";
            ctx.fillText(branch, x, 20);
        });
    
        // Draw commits and connections
        commits.forEach((commit, i) => {
            if (!commit || !commit.id || !commit.message) {
                console.error("Invalid commit object:", commit);
                return;
            }
    
            const branch = commit.branch || "main";
            const branchIndex = branchNames.indexOf(branch);
            const x = branchSpacing * (branchIndex + 1);
            const y = 50 + i * verticalSpacing;
    
            commitPositions[commit.id] = { x, y };
    
            // Store commit details for tooltips
            commitDetails[commit.id] = commit;
    
            // Draw connections to parent commits
            if (i > 0) {
                const parentCommit = commits[i - 1];
                const parentPos = commitPositions[parentCommit.id];
                if (parentPos) {
                    ctx.beginPath();
                    ctx.moveTo(x, y - nodeRadius);
                    ctx.lineTo(parentPos.x, parentPos.y + nodeRadius);
                    ctx.strokeStyle = branchColors[branch];
                    ctx.lineWidth = 2;
                    ctx.stroke();
                }
            }
    
            // Draw the commit node
            ctx.beginPath();
            ctx.arc(x, y, nodeRadius, 0, 2 * Math.PI);
            ctx.fillStyle = branchColors[branch];
            ctx.fill();
            ctx.strokeStyle = "#1E40AF";
            ctx.lineWidth = 2;
            ctx.stroke();
    
            // Draw commit hash
            ctx.fillStyle = '#FFFFFF';
            ctx.font = "bold 12px Arial";
            ctx.textAlign = "center";
            ctx.fillText(commit.id.slice(0, 7), x, y + 5);
        });
    }

    function adjustCanvasSize(state) {
        if (!state || !state.branches) return;

        let maxCommits = 0;
        Object.values(state.branches).forEach(commits => {
            if (commits.length > maxCommits) {
                maxCommits = commits.length;
            }
        });

        const newHeight = Math.max(200, maxCommits * 120);
        canvas.height = newHeight;
    }

    fetchState();
    setInterval(fetchState, 10000);
    window.addFile = addFile;
    window.commit = commit;
    window.createBranch = createBranch;
});