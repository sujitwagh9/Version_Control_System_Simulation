from flask import Flask, render_template, jsonify, request
import hashlib

app = Flask(__name__)

# Central repository state
repo = {
    "commits": [],
    "branches": {"main": []},
    "staging_area": {},
    "current_branch": "main"
}

def reset_git_state():
    """ Clears history and resets Git state when simulation is accessed """
    global repo
    repo = {
        "commits": [],
        "branches": {"main": []},
        "staging_area": {},
        "current_branch": "main"
    }

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/simulation')
def simulation():
    reset_git_state()  # Reset state every time the simulation page is loaded
    return render_template('simulation.html')

@app.route('/state')
def get_state():
    return jsonify(repo)

@app.route('/add', methods=['POST'])
def add():
    data = request.json
    filename, content = data.get('filename'), data.get('content')
    
    if not filename or not content:
        return jsonify({"message": "Filename and content are required!", "state": repo})
    
    repo["staging_area"][filename] = content
    # print(f"Staged {filename} with content: {content}")  # Debug log
    return jsonify({"message": f"Added {filename} to staging.", "state": repo})


@app.route('/switch_branch', methods=['POST'])
def switch_branch():
    data = request.json
    target_branch = data.get('target_branch')

    if not target_branch:
        return jsonify({"message": "Error: Target branch is required!", "state": repo})

    if target_branch not in repo["branches"]:
        return jsonify({"message": f"Error: Branch '{target_branch}' does not exist!", "state": repo})

    # Store the current branch as the previous branch
    repo["previous_branch"] = repo["current_branch"]

    # Switch to the target branch
    repo["current_branch"] = target_branch

    return jsonify({"message": f"Switched to branch '{target_branch}'", "state": repo})

@app.route('/commit', methods=['POST'])
def commit():
    data = request.json
    message = data.get('message', '')

    if not repo["staging_area"]:
        return jsonify({'message': "Error: No files staged for commit", 'state': repo})

    # Generate commit hash
    commit_content = "".join(repo["staging_area"].values())
    commit_id = hashlib.sha1(f"{message}{commit_content}".encode()).hexdigest()[:7]

    # Ensure unique commit ID
    while any(c['id'] == commit_id for c in repo["commits"]):
        commit_id = hashlib.sha1(f"{commit_id}{commit_content}".encode()).hexdigest()[:7]

    # Get committed filenames from request
    committed_files = data.get("committed_files", [])  # Expect a list of filenames
    if not committed_files:
        return jsonify({'message': "Error: No files selected for commit", 'state': repo})

    # Create commit object
    commit_data = {
        'id': commit_id,
        'message': message,
        'files': {filename: repo["staging_area"][filename] for filename in committed_files if filename in repo["staging_area"]},
        'branch': repo["current_branch"]  # Track the branch this commit belongs to
    }

    repo["commits"].append(commit_data)
    repo["branches"][repo["current_branch"]].append(commit_id)

    # Remove only committed files from the staging area
    for filename in committed_files:
        repo["staging_area"].pop(filename, None)

    print(f"Commit created: {commit_data}")
    print(f"Staging area after commit: {repo['staging_area']}")

    return jsonify({'message': "Commit successful", 'state': repo})

@app.route('/branch', methods=['POST'])
def create_branch():
    data = request.json
    branch_name = data.get('branch_name')

    if not branch_name:
        return jsonify({"message": "Branch name is required!", "state": repo})

    if branch_name in repo["branches"]:
        return jsonify({"message": "Branch already exists!", "state": repo})

    # Create new branch with a copy of commits from the current branch
    repo["branches"][branch_name] = repo["branches"][repo["current_branch"]][:]

    # Preserve uncommitted changes in the new branch
    # Note: The staging area is shared across branches unless explicitly cleared
    repo["staging_area"] = repo["staging_area"].copy()

    # Store the current branch name
    repo["previous_branch"] = repo["current_branch"]

    # Switch to the new branch
    repo["current_branch"] = branch_name

    return jsonify({"message": f"Branch {branch_name} created and switched to.", "state": repo})

@app.route('/merge', methods=['POST'])
def merge():
    data = request.json
    source_branch = data.get('source_branch')

    if source_branch not in repo["branches"]:
        return jsonify({"message": f"Branch {source_branch} does not exist!", "state": repo})

    if source_branch == repo["current_branch"]:
        return jsonify({"message": "Cannot merge a branch into itself!", "state": repo})

    existing_commits = set(repo["branches"][repo["current_branch"]])
    new_commits = [c for c in repo["branches"][source_branch] if c not in existing_commits]

    if not new_commits:
        return jsonify({"message": f"No new changes from {source_branch} to merge.", "state": repo})

    # Collect all files from new commits
    merged_files = {}
    for commit_id in new_commits:
        commit = next((c for c in repo["commits"] if c["id"] == commit_id), None)
        if commit:
            for filename, content in commit["files"].items():
                if filename in merged_files:
                    # Placeholder for conflict resolution
                    print(f"Conflict detected for file: {filename}")
                merged_files[filename] = content

    # Create a merge commit
    merge_commit_id = hashlib.sha1(f"Merge {source_branch} into {repo['current_branch']}".encode()).hexdigest()[:7]
    merge_message = f"Merge branch '{source_branch}' into {repo['current_branch']}"

    merge_commit_data = {
        "id": merge_commit_id,
        "message": merge_message,
        "files": merged_files  # Include merged files
    }

    repo["commits"].append(merge_commit_data)
    repo["branches"][repo["current_branch"]].extend(list(set(new_commits + [merge_commit_id])))

    return jsonify({"message": f"Merged {source_branch} into {repo['current_branch']}", "state": repo})


if __name__ == '__main__':
    app.run(debug=True)
