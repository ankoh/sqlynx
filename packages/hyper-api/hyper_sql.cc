#include <hyperapi/hyperapi.hpp>

#include <filesystem>
#include <iostream>
#include <string>
#include <string_view>
#include <vector>

namespace {

struct Arguments {
    std::filesystem::path hyperd;
    std::filesystem::path output;
    std::string sql;
    std::vector<std::pair<std::string, std::filesystem::path>> sources;
};

void ReplaceAll(std::string& value, std::string_view needle, std::string_view replacement) {
    for (size_t position = value.find(needle); position != std::string::npos;
         position = value.find(needle, position + replacement.size())) {
        value.replace(position, needle.size(), replacement);
    }
}

Arguments ParseArguments(int argc, char** argv) {
    Arguments args;
    for (int i = 1; i < argc; ++i) {
        const std::string_view option{argv[i]};
        if (option == "--hyperd" && i + 1 < argc) {
            args.hyperd = argv[++i];
        } else if (option == "--output" && i + 1 < argc) {
            args.output = argv[++i];
        } else if (option == "--source" && i + 2 < argc) {
            const std::string name{argv[++i]};
            const std::filesystem::path path{argv[++i]};
            args.sources.emplace_back(name, path);
        } else if (option == "--sql" && i + 1 < argc) {
            args.sql = argv[++i];
        } else {
            throw std::runtime_error{"usage: hyper_sql --hyperd <path> --output <directory> [--source <name> <path>] --sql <statement>"};
        }
    }
    if (args.hyperd.empty() || args.output.empty() || args.sql.empty()) {
        throw std::runtime_error{"usage: hyper_sql --hyperd <path> --output <directory> [--source <name> <path>] --sql <statement>"};
    }
    return args;
}

}  // namespace

int main(int argc, char** argv) {
    try {
        auto args = ParseArguments(argc, argv);
        args.hyperd = std::filesystem::absolute(args.hyperd);
        args.output = std::filesystem::absolute(args.output);
        for (const auto& [name, path] : args.sources) {
            ReplaceAll(args.sql, "{" + name + "}", std::filesystem::absolute(path).string());
        }
        ReplaceAll(args.sql, "{output}", ".");
        std::filesystem::current_path(args.output);
        hyperapi::HyperProcess process{
            args.hyperd.parent_path().string(),
            hyperapi::Telemetry::DoNotSendUsageDataToTableau,
            "dashql-data",
            {{"log_config", ""}},
        };
        hyperapi::Connection connection{process.getEndpoint()};
        connection.executeCommand(args.sql);
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
